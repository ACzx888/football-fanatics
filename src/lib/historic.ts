import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  searchHistoricFootballMatches,
  type RawHistoricMatch,
} from "./hkjc-graphql";
import { addDaysHkt, formatHktDate } from "./time";

/** One completed match from a team's perspective. */
export interface TeamMatchSample {
  matchId: string;
  date: string;
  isHome: boolean;
  goalsFor: number;
  goalsAgainst: number;
  result: "W" | "D" | "L";
  /** Total corners when HKJC provides them (>=0); usually unavailable. */
  totalCorners: number | null;
  opponentId: string;
  opponentName: string;
  /** Provenance when sample came from an external enricher. */
  source?: import("./types").PredictionSource;
}

export interface TeamForm {
  teamId: string;
  teamName: string;
  samples: TeamMatchSample[];
  ppg: number;
  avgScored: number;
  avgConceded: number;
  avgScoredHome: number;
  avgConcededHome: number;
  avgScoredAway: number;
  avgConcededAway: number;
  /** Recent form score in [-1, 1] from last N W/D/L (W=1,D=0,L=-1). */
  formScore: number;
  homeSamples: number;
  awaySamples: number;
}

export interface FormCoverage {
  teamsRequested: number;
  teamsWithForm: number;
  teamsWithAtLeast2: number;
  teamsFromKv: number;
  teamsFetched: number;
  timedOut: boolean;
  lookbackDays: number;
  numWindows: number;
}

export interface HistoricBundle {
  byTeamId: Map<string, TeamMatchSample[]>;
  /** Lowercased English name → samples (fallback when id miss). */
  byTeamName: Map<string, TeamMatchSample[]>;
  leagueAvgGoals: number;
  fetchedAt: number;
  lookbackDays: number;
  matchCount: number;
  ok: boolean;
  note: string;
  formCoverage: FormCoverage;
}

export type TeamRef = { id: string; name: string };

/**
 * HKJC matchResult returns empty matches when startDate..endDate spans more
 * than ~32 calendar days (matchNumByDate.total can still be correct).
 * Stack fixed ~14d windows to cover ~84 days of history per team.
 */
const WINDOW_DAYS = 14;
const NUM_WINDOWS = 6; // ~84d lookback (6 × 14)
const MAX_PER_WINDOW = 40;
const PAGE = 20;
const CONCURRENCY = 8;
const MAX_SAMPLES_PER_TEAM = 12;
/** Soft budget for /api/matches historic enrichment on Workers (~30s OpenNext). */
export const HISTORIC_BUDGET_MS = 12_000;
const PER_REQUEST_TIMEOUT_MS = 4_000;
/** ≥2 samples: keep longer so warm KV hits skip network. */
const KV_TTL_COMPLETE_SECONDS = 36 * 60 * 60; // 36h
/** 0–1 samples: short TTL so next request retries deeper windows. */
const KV_TTL_INCOMPLETE_SECONDS = 90 * 60; // 1.5h
const KV_KEY_PREFIX = "teamform:v2:";
const MEMORY_TTL_MS = 20 * 60 * 1000;
const MEMORY_TTL_INCOMPLETE_MS = 2 * 60 * 1000; // 2 min — force deepen soon
/** Skip network refresh when KV/memory already has this many samples. */
const FAT_SAMPLE_SKIP = 6;
/**
 * Stop stacking windows once a team reaches this many samples.
 * Keep low (just above HAD gate) so budget covers more teams.
 */
const TARGET_SAMPLES = 3;

type KvTeamPayload = {
  teamId: string;
  teamName: string;
  samples: TeamMatchSample[];
  cachedAt: number;
  lookbackDays: number;
  incomplete?: boolean;
};

type HistoricGlobal = {
  teamCache: Map<string, { samples: TeamMatchSample[]; cachedAt: number }>;
};

type FfKv = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
};

const g = globalThis as typeof globalThis & { __ffHistoricV4?: HistoricGlobal };
if (!g.__ffHistoricV4) {
  g.__ffHistoricV4 = { teamCache: new Map() };
}

function getStore(): HistoricGlobal {
  return g.__ffHistoricV4!;
}

function lookbackDaysTotal(): number {
  return WINDOW_DAYS * NUM_WINDOWS;
}

async function getHistoricKv(): Promise<FfKv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as { HISTORIC_CACHE?: FfKv } | undefined;
    return env?.HISTORIC_CACHE ?? null;
  } catch {
    return null;
  }
}

async function mapPool(
  items: string[],
  limit: number,
  fn: (id: string) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      if (shouldStop?.()) break;
      const idx = i++;
      await fn(items[idx]);
    }
  }
  const n = Math.min(limit, Math.max(items.length, 0));
  if (n <= 0) return;
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * Pick full-time score row. HKJC returns progressive stage rows;
 * stageId 5 + resultType 1 is the settled FT score when present.
 */
export function pickFullTimeResult(
  results:
    | Array<{
        homeResult?: number;
        awayResult?: number;
        ttlCornerResult?: number;
        stageId?: number;
        resultType?: number;
        payoutConfirmed?: boolean;
        sequence?: number;
      }>
    | null
    | undefined
): {
  home: number;
  away: number;
  corners: number | null;
} | null {
  if (!results?.length) return null;
  const ftCandidates = results.filter(
    (r) => r.stageId === 5 && (r.resultType == null || r.resultType === 1)
  );
  const row =
    ftCandidates[ftCandidates.length - 1] ||
    results.filter((r) => r.resultType === 1).slice(-1)[0] ||
    results[results.length - 1];
  if (row?.homeResult == null || row?.awayResult == null) return null;
  // Prefer FT-row corners; else any stage/resultType row with ttlCornerResult ≥ 0
  // (HKJC often leaves FT ttlCornerResult as -1 even when another row has it).
  let corners: number | null = null;
  const c = row.ttlCornerResult;
  if (c != null && c >= 0) {
    corners = c;
  } else {
    for (const r of results) {
      const v = r.ttlCornerResult;
      if (v != null && v >= 0) {
        corners = v;
        break;
      }
    }
  }
  return {
    home: row.homeResult,
    away: row.awayResult,
    corners,
  };
}

function sampleFromMatch(
  m: RawHistoricMatch,
  perspectiveTeamId: string
): TeamMatchSample | null {
  if (!m.id || !m.homeTeam?.id || !m.awayTeam?.id) return null;
  const ft = pickFullTimeResult(m.results);
  if (!ft) return null;
  const date = (m.matchDate || "").slice(0, 10);
  const isHome = m.homeTeam.id === perspectiveTeamId;
  const isAway = m.awayTeam.id === perspectiveTeamId;
  if (!isHome && !isAway) return null;
  if (isHome) {
    return {
      matchId: m.id,
      date,
      isHome: true,
      goalsFor: ft.home,
      goalsAgainst: ft.away,
      result: ft.home > ft.away ? "W" : ft.home < ft.away ? "L" : "D",
      totalCorners: ft.corners,
      opponentId: m.awayTeam.id,
      opponentName: m.awayTeam.name_en || "Away",
    };
  }
  return {
    matchId: m.id,
    date,
    isHome: false,
    goalsFor: ft.away,
    goalsAgainst: ft.home,
    result: ft.away > ft.home ? "W" : ft.away < ft.home ? "L" : "D",
    totalCorners: ft.corners,
    opponentId: m.homeTeam.id,
    opponentName: m.homeTeam.name_en || "Home",
  };
}

function dedupeSortTrim(samples: TeamMatchSample[]): TeamMatchSample[] {
  const seen = new Set<string>();
  const out: TeamMatchSample[] = [];
  for (const s of samples) {
    const key = `${s.matchId}:${s.isHome ? "H" : "A"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, MAX_SAMPLES_PER_TEAM);
}

/** Single ~WINDOW_DAYS range ending `windowIndex` windows ago. */
function windowRange(
  now: Date,
  windowIndex: number
): { startDate: string; endDate: string } {
  const endOffset = 1 + windowIndex * WINDOW_DAYS;
  const startOffset = endOffset + (WINDOW_DAYS - 1);
  return {
    startDate: addDaysHkt(now, -startOffset),
    endDate: addDaysHkt(now, -endOffset),
  };
}

/**
 * Fetch historic samples for one team across stacked windows.
 * Completes deeper windows for this team before the caller moves on —
 * prefers reaching minSamples over starting brand-new teams.
 *
 * If the first two scanned windows yield nothing and there is no seed,
 * abandon deeper lookback (team likely absent from HKJC history) so we
 * do not rate-limit the API on forever-empty U20 / friendly sides.
 */
async function fetchTeamSamplesNetwork(
  teamId: string,
  opts: {
    budgetExceeded: () => boolean;
    minSamples?: number;
    startWindow?: number;
    /** How many windows to scan from startWindow (default: remaining). */
    maxWindows?: number;
    seed?: TeamMatchSample[];
  }
): Promise<TeamMatchSample[]> {
  const seed = opts.seed || [];
  const collected: TeamMatchSample[] = [...seed];
  const seen = new Set(
    collected.map((s) => `${s.matchId}:${s.isHome ? "H" : "A"}`)
  );
  const minSamples = opts.minSamples ?? 2;
  const startWindow = opts.startWindow ?? 0;
  const endWindow = Math.min(
    NUM_WINDOWS,
    startWindow + (opts.maxWindows ?? NUM_WINDOWS)
  );
  const now = new Date();
  let scannedEmpty = 0;

  for (let w = startWindow; w < endWindow; w++) {
    if (opts.budgetExceeded()) break;
    if (collected.length >= Math.max(minSamples, TARGET_SAMPLES)) break;
    if (collected.length >= MAX_SAMPLES_PER_TEAM) break;

    const before = collected.length;
    const range = windowRange(now, w);
    for (let start = 0; start < MAX_PER_WINDOW; start += PAGE) {
      if (opts.budgetExceeded()) break;
      try {
        const r = await searchHistoricFootballMatches(
          {
            startDate: range.startDate,
            endDate: range.endDate,
            startIndex: start,
            endIndex: start + PAGE,
            teamId,
          },
          { timeoutMs: PER_REQUEST_TIMEOUT_MS }
        );
        const batch = r.matches || [];
        for (const m of batch) {
          const sample = sampleFromMatch(m, teamId);
          if (!sample) continue;
          const key = `${sample.matchId}:${sample.isHome ? "H" : "A"}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(sample);
        }
        const total = r.matchNumByDate?.total || 0;
        if (batch.length < PAGE || start + PAGE >= total) break;
      } catch {
        break;
      }
    }

    if (collected.length === before) scannedEmpty++;
    else scannedEmpty = 0;

    // No seed + two consecutive empty windows → stop burning budget
    if (seed.length === 0 && collected.length === 0 && scannedEmpty >= 2) {
      break;
    }
  }

  return dedupeSortTrim(collected);
}

async function readTeamFromKv(
  kv: FfKv,
  teamId: string
): Promise<KvTeamPayload | null> {
  try {
    const raw = await kv.get(`${KV_KEY_PREFIX}${teamId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KvTeamPayload;
    if (!parsed?.samples || !Array.isArray(parsed.samples)) return null;
    return {
      ...parsed,
      samples: dedupeSortTrim(parsed.samples),
      incomplete:
        parsed.incomplete === true ||
        !parsed.samples ||
        parsed.samples.length < 2,
    };
  } catch {
    return null;
  }
}

async function writeTeamToKv(
  kv: FfKv,
  teamId: string,
  teamName: string,
  samples: TeamMatchSample[]
): Promise<void> {
  try {
    const incomplete = samples.length < 2;
    const payload: KvTeamPayload = {
      teamId,
      teamName,
      samples,
      cachedAt: Date.now(),
      lookbackDays: lookbackDaysTotal(),
      incomplete,
    };
    await kv.put(`${KV_KEY_PREFIX}${teamId}`, JSON.stringify(payload), {
      expirationTtl: incomplete
        ? KV_TTL_INCOMPLETE_SECONDS
        : KV_TTL_COMPLETE_SECONDS,
    });
  } catch {
    // ignore KV write failures
  }
}

function emptyCoverage(partial?: Partial<FormCoverage>): FormCoverage {
  return {
    teamsRequested: 0,
    teamsWithForm: 0,
    teamsWithAtLeast2: 0,
    teamsFromKv: 0,
    teamsFetched: 0,
    timedOut: false,
    lookbackDays: lookbackDaysTotal(),
    numWindows: NUM_WINDOWS,
    ...partial,
  };
}

function emptyBundle(note: string, coverage?: FormCoverage): HistoricBundle {
  return {
    byTeamId: new Map(),
    byTeamName: new Map(),
    leagueAvgGoals: 1.3,
    fetchedAt: Date.now(),
    lookbackDays: lookbackDaysTotal(),
    matchCount: 0,
    ok: false,
    note,
    formCoverage: coverage ?? emptyCoverage(),
  };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Patch totalCorners onto a cached team sample after settlement.
 * Builds real corner history over time when HKJC historic lacks ttlCornerResult.
 */
export async function enrichTeamSampleCorners(
  teamId: string,
  teamName: string,
  matchId: string,
  totalCorners: number,
  isHome: boolean
): Promise<boolean> {
  if (!teamId || totalCorners < 0) return false;
  const kv = await getHistoricKv();
  const store = getStore();
  let samples =
    store.teamCache.get(teamId)?.samples ||
    (kv ? (await readTeamFromKv(kv, teamId))?.samples : null) ||
    [];
  if (!samples.length) {
    // Seed a minimal sample so future form can carry corners
    samples = [
      {
        matchId,
        date: "",
        isHome,
        goalsFor: 0,
        goalsAgainst: 0,
        result: "D",
        totalCorners,
        opponentId: "",
        opponentName: "",
      },
    ];
  } else {
    let hit = false;
    samples = samples.map((s) => {
      if (s.matchId !== matchId) return s;
      hit = true;
      if (s.totalCorners != null && s.totalCorners >= 0) return s;
      return { ...s, totalCorners };
    });
    if (!hit) {
      samples = dedupeSortTrim([
        {
          matchId,
          date: "",
          isHome,
          goalsFor: 0,
          goalsAgainst: 0,
          result: "D",
          totalCorners,
          opponentId: "",
          opponentName: "",
        },
        ...samples,
      ]);
    }
  }
  samples = dedupeSortTrim(samples);
  store.teamCache.set(teamId, { samples, cachedAt: Date.now() });
  if (kv) await writeTeamToKv(kv, teamId, teamName || teamId, samples);
  return true;
}

export function buildTeamForm(
  teamId: string,
  teamName: string,
  samples: TeamMatchSample[] | undefined
): TeamForm | null {
  if (!samples?.length) return null;
  const recent = samples.slice(0, MAX_SAMPLES_PER_TEAM);
  const home = recent.filter((s) => s.isHome);
  const away = recent.filter((s) => !s.isHome);
  const pts = recent.reduce(
    (a, s) => a + (s.result === "W" ? 3 : s.result === "D" ? 1 : 0),
    0
  );
  const formVals = recent.map((s) =>
    s.result === "W" ? 1 : s.result === "D" ? 0 : -1
  );
  let wSum = 0;
  let wTot = 0;
  formVals.forEach((v, i) => {
    const w = 1 + (formVals.length - 1 - i) * 0.08;
    wSum += v * w;
    wTot += w;
  });

  return {
    teamId,
    teamName,
    samples: recent,
    ppg: pts / recent.length,
    avgScored: avg(recent.map((s) => s.goalsFor)),
    avgConceded: avg(recent.map((s) => s.goalsAgainst)),
    avgScoredHome: home.length
      ? avg(home.map((s) => s.goalsFor))
      : avg(recent.map((s) => s.goalsFor)),
    avgConcededHome: home.length
      ? avg(home.map((s) => s.goalsAgainst))
      : avg(recent.map((s) => s.goalsAgainst)),
    avgScoredAway: away.length
      ? avg(away.map((s) => s.goalsFor))
      : avg(recent.map((s) => s.goalsFor)),
    avgConcededAway: away.length
      ? avg(away.map((s) => s.goalsAgainst))
      : avg(recent.map((s) => s.goalsAgainst)),
    formScore: wTot > 0 ? wSum / wTot : 0,
    homeSamples: home.length,
    awaySamples: away.length,
  };
}

export function getTeamForm(
  bundle: HistoricBundle,
  teamId: string | undefined,
  teamName: string
): TeamForm | null {
  if (teamId && bundle.byTeamId.has(teamId)) {
    const samples = bundle.byTeamId.get(teamId);
    if (samples?.length) return buildTeamForm(teamId, teamName, samples);
  }
  const key = teamName.trim().toLowerCase();
  if (key && bundle.byTeamName.has(key)) {
    const samples = bundle.byTeamName.get(key);
    if (samples?.length) {
      return buildTeamForm(teamId || key, teamName, samples);
    }
  }
  return null;
}

/**
 * Team-targeted historic form loader.
 * 1) Memory cache → 2) Cloudflare KV → 3) HKJC matchResult(teamId) stacked windows.
 * Incomplete (0–1 sample) cache hits are seeded but still deepened on network.
 */
export async function loadHistoricForTeams(
  teams: TeamRef[],
  opts?: {
    budgetMs?: number;
    priorityIds?: string[];
    matchPairs?: Array<[string, string]>;
  }
): Promise<HistoricBundle> {
  const unique = new Map<string, string>();
  for (const t of teams) {
    if (!t?.id) continue;
    if (!unique.has(t.id)) unique.set(t.id, t.name || t.id);
  }
  const teamIds = [...unique.keys()];
  if (teamIds.length === 0) {
    return emptyBundle("No team IDs on live matches");
  }

  const budgetMs = opts?.budgetMs ?? HISTORIC_BUDGET_MS;
  const started = Date.now();
  const budgetExceeded = () => Date.now() - started >= budgetMs;
  const store = getStore();
  const kv = await getHistoricKv();

  const byTeamId = new Map<string, TeamMatchSample[]>();
  let teamsFromKv = 0;
  let teamsFetched = 0;

  // Teams that need network deepen (0 or 1 samples, or missing)
  const needDeepen = new Set<string>();

  // 1) Memory — solid (≥2) hits within TTL skip network; thin seed + deepen
  for (const id of teamIds) {
    const mem = store.teamCache.get(id);
    if (!mem) {
      needDeepen.add(id);
      continue;
    }
    const n = mem.samples.length;
    const age = Date.now() - mem.cachedAt;
    if (n >= FAT_SAMPLE_SKIP && age < MEMORY_TTL_MS) {
      byTeamId.set(id, mem.samples);
      continue;
    }
    if (n >= 2 && age < MEMORY_TTL_MS) {
      byTeamId.set(id, mem.samples);
      continue;
    }
    if (n > 0 && age < MEMORY_TTL_INCOMPLETE_MS) {
      byTeamId.set(id, mem.samples);
      if (n < 2) needDeepen.add(id);
      continue;
    }
    // Stale or empty memory — re-check KV / network
    if (n > 0) byTeamId.set(id, mem.samples); // seed only
    needDeepen.add(id);
  }

  // 2) KV for teams still needing deepen (or missing solid cache)
  const needKv = [...needDeepen];
  if (kv && needKv.length) {
    await mapPool(needKv, Math.min(8, needKv.length), async (id) => {
      const payload = await readTeamFromKv(kv, id);
      if (!payload) return;
      const samples = payload.samples;
      teamsFromKv++;
      if (!samples.length) {
        // Known-empty within short TTL — do not re-hammer HKJC this request
        store.teamCache.set(id, {
          samples: [],
          cachedAt: Date.now() - MEMORY_TTL_MS + MEMORY_TTL_INCOMPLETE_MS,
        });
        needDeepen.delete(id);
        return;
      }
      const existing = byTeamId.get(id) || [];
      const merged = dedupeSortTrim([...existing, ...samples]);
      byTeamId.set(id, merged);
      store.teamCache.set(id, { samples: merged, cachedAt: Date.now() });
      if (merged.length >= 2 && !payload.incomplete) {
        needDeepen.delete(id);
      } else if (merged.length >= FAT_SAMPLE_SKIP) {
        needDeepen.delete(id);
      } else {
        // Keep in needDeepen for older windows (1-sample incomplete)
        needDeepen.add(id);
      }
    });
  }

  // 3) Priority: 0-sample first, then 1-sample deepen, pair-boosted
  const sampleCount = (id: string) => byTeamId.get(id)?.length ?? 0;
  const pairBoost = new Map<string, number>();
  for (const pair of opts?.matchPairs || []) {
    const [h, a] = pair;
    const hs = sampleCount(h);
    const as_ = sampleCount(a);
    if (hs >= 2 && as_ < 2) pairBoost.set(a, (pairBoost.get(a) || 0) + 10);
    else if (as_ >= 2 && hs < 2) pairBoost.set(h, (pairBoost.get(h) || 0) + 10);
    else if (hs < 2 && as_ < 2) {
      pairBoost.set(h, (pairBoost.get(h) || 0) + 3);
      pairBoost.set(a, (pairBoost.get(a) || 0) + 3);
    }
  }

  const toFetch = [...needDeepen]
    .filter((id) => sampleCount(id) < FAT_SAMPLE_SKIP)
    .sort((a, b) => {
      const sa = sampleCount(a);
      const sb = sampleCount(b);
      // Missing form (0) before thin (1) before anyone else
      if (sa !== sb) return sa - sb;
      const ba = pairBoost.get(a) || 0;
      const bb = pairBoost.get(b) || 0;
      if (ba !== bb) return bb - ba;
      return 0;
    });

  async function persistTeam(
    id: string,
    merged: TeamMatchSample[],
    seedLen: number
  ): Promise<void> {
    const name = unique.get(id) || id;
    if (merged.length > 0) {
      byTeamId.set(id, merged);
      store.teamCache.set(id, { samples: merged, cachedAt: Date.now() });
      if (kv) await writeTeamToKv(kv, id, name, merged);
    } else if (seedLen === 0) {
      store.teamCache.set(id, {
        samples: [],
        cachedAt: Date.now() - MEMORY_TTL_MS + 90_000,
      });
      if (kv) await writeTeamToKv(kv, id, name, []);
    }
  }

  /**
   * Pass 1 — recent history only (2×14d ≈ 28d) for every thin/missing team.
   * Maximizes how many teams get ≥1 sample before deeper lookback.
   */
  async function fetchRecent(id: string): Promise<void> {
    if (budgetExceeded()) return;
    const seed = byTeamId.get(id) || [];
    if (seed.length >= TARGET_SAMPLES) return;
    try {
      const samples = await fetchTeamSamplesNetwork(id, {
        budgetExceeded,
        minSamples: 2,
        startWindow: 0,
        maxWindows: 2,
        seed,
      });
      teamsFetched++;
      await persistTeam(id, dedupeSortTrim([...seed, ...samples]), seed.length);
    } catch {
      // ignore
    }
  }

  if (toFetch.length && !budgetExceeded()) {
    await mapPool(toFetch, CONCURRENCY, fetchRecent, budgetExceeded);
  }

  /**
   * Pass 2 — deepen teams still below 2 samples using older windows (28–84d).
   * Prefer pair-boosted thin sides so match pairs unlock HAD together.
   */
  if (!budgetExceeded()) {
    const needOlder = teamIds
      .filter((id) => sampleCount(id) < 2)
      .sort((a, b) => {
        const sa = sampleCount(a);
        const sb = sampleCount(b);
        // Finish 1-sample teams before pure empties (empties likely hopeless)
        if (sa !== sb) return sb - sa;
        return (pairBoost.get(b) || 0) - (pairBoost.get(a) || 0);
      });
    if (needOlder.length) {
      await mapPool(
        needOlder,
        CONCURRENCY,
        async (id) => {
          if (budgetExceeded()) return;
          const seed = byTeamId.get(id) || [];
          // Skip empties that already failed recent windows — low odds of history
          if (seed.length === 0) return;
          try {
            const samples = await fetchTeamSamplesNetwork(id, {
              budgetExceeded,
              minSamples: 2,
              startWindow: 2,
              maxWindows: NUM_WINDOWS - 2,
              seed,
            });
            teamsFetched++;
            const merged = dedupeSortTrim(samples);
            if (merged.length > seed.length) {
              await persistTeam(id, merged, seed.length);
            }
          } catch {
            // ignore
          }
        },
        budgetExceeded
      );
    }
  }

  /**
   * Pass 3 — if budget remains, try older windows for still-empty teams
   * (clubs that simply did not play in the last ~28d but have 30–60d history).
   */
  if (!budgetExceeded()) {
    const stillEmpty = teamIds
      .filter((id) => sampleCount(id) === 0)
      .sort((a, b) => (pairBoost.get(b) || 0) - (pairBoost.get(a) || 0));
    if (stillEmpty.length) {
      await mapPool(
        stillEmpty,
        CONCURRENCY,
        async (id) => {
          if (budgetExceeded()) return;
          try {
            const samples = await fetchTeamSamplesNetwork(id, {
              budgetExceeded,
              minSamples: 2,
              startWindow: 2,
              maxWindows: 2, // days 29–56 only
              seed: [],
            });
            teamsFetched++;
            await persistTeam(id, samples, 0);
          } catch {
            // ignore
          }
        },
        budgetExceeded
      );
    }
  }

  const byTeamName = new Map<string, TeamMatchSample[]>();
  let matchCount = 0;
  let goalSum = 0;
  let goalN = 0;
  for (const id of teamIds) {
    const trimmed = dedupeSortTrim(byTeamId.get(id) || []);
    if (trimmed.length) byTeamId.set(id, trimmed);
    else byTeamId.delete(id);
    const name = (unique.get(id) || "").trim().toLowerCase();
    if (name && trimmed.length) byTeamName.set(name, trimmed);
    matchCount += trimmed.length;
    for (const s of trimmed) {
      goalSum += s.goalsFor;
      goalN++;
    }
  }

  const teamsWithForm = teamIds.filter(
    (id) => (byTeamId.get(id)?.length ?? 0) > 0
  ).length;
  const teamsWithAtLeast2 = teamIds.filter(
    (id) => (byTeamId.get(id)?.length ?? 0) >= 2
  ).length;
  const timedOut =
    budgetExceeded() && toFetch.length > 0 && teamsFetched < toFetch.length;
  const leagueAvgGoals = goalN > 0 ? goalSum / goalN : 1.3;
  const lookbackDays = lookbackDaysTotal();

  const coverage: FormCoverage = {
    teamsRequested: teamIds.length,
    teamsWithForm,
    teamsWithAtLeast2,
    teamsFromKv,
    teamsFetched,
    timedOut,
    lookbackDays,
    numWindows: NUM_WINDOWS,
  };

  let note: string;
  if (teamsWithForm > 0) {
    note = `Team historic: ${teamsWithForm}/${teamIds.length} teams with form (≥2: ${teamsWithAtLeast2}) · ~${lookbackDays}d (${NUM_WINDOWS}×${WINDOW_DAYS}d) · kv ${teamsFromKv} · fetched ${teamsFetched}${
      timedOut ? " · partial (budget)" : ""
    }`;
  } else if (timedOut) {
    note =
      "Historic team fetch timed out before samples; live matches still shown";
  } else {
    note =
      "Historic HKJC returned no team samples; predictions need form samples";
  }

  return {
    byTeamId,
    byTeamName,
    leagueAvgGoals,
    fetchedAt: Date.now(),
    lookbackDays,
    matchCount,
    ok: teamsWithForm > 0,
    note,
    formCoverage: coverage,
  };
}

export async function getHistoricBundleSoft(
  timeoutMs?: number
): Promise<HistoricBundle | null> {
  void timeoutMs;
  return emptyBundle(
    "Call loadHistoricForTeams with live team IDs (day-scan historic disabled)"
  );
}

export function formatHktToday(): string {
  return formatHktDate(new Date());
}
