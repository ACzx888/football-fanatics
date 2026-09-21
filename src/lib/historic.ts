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
 * Stack fixed ~30d windows to cover ~60 days of history per team.
 */
const WINDOW_DAYS = 14; // faster; still usually ≥2 samples
const NUM_WINDOWS = 1; // 30d only — HKJC empties beyond ~32d span
const MAX_PER_WINDOW = 40;
const PAGE = 20;
const CONCURRENCY = 8;
const MAX_SAMPLES_PER_TEAM = 12;
/** Soft budget for /api/matches historic enrichment on Workers. */
export const HISTORIC_BUDGET_MS = 14_000;
const PER_REQUEST_TIMEOUT_MS = 4_500;
const KV_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const KV_KEY_PREFIX = "teamform:v1:";
const MEMORY_TTL_MS = 20 * 60 * 1000;

type KvTeamPayload = {
  teamId: string;
  teamName: string;
  samples: TeamMatchSample[];
  cachedAt: number;
  lookbackDays: number;
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

const g = globalThis as typeof globalThis & { __ffHistoricV3?: HistoricGlobal };
if (!g.__ffHistoricV3) {
  g.__ffHistoricV3 = { teamCache: new Map() };
}

function getStore(): HistoricGlobal {
  return g.__ffHistoricV3!;
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
  const c = row.ttlCornerResult;
  return {
    home: row.homeResult,
    away: row.awayResult,
    corners: c != null && c >= 0 ? c : null,
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

function windowRanges(
  now: Date = new Date(),
  windowIndex = 0
): Array<{ startDate: string; endDate: string }> {
  const endOffset = 1 + windowIndex * WINDOW_DAYS;
  const startOffset = endOffset + (WINDOW_DAYS - 1);
  return [
    {
      startDate: addDaysHkt(now, -startOffset),
      endDate: addDaysHkt(now, -endOffset),
    },
  ];
}

async function fetchTeamSamplesNetwork(
  teamId: string,
  opts: { budgetExceeded: () => boolean; minSamples?: number; windowIndex?: number }
): Promise<TeamMatchSample[]> {
  const ranges = windowRanges(new Date(), opts.windowIndex ?? 0);
  const collected: TeamMatchSample[] = [];
  const seen = new Set<string>();
  const minSamples = opts.minSamples ?? 3;

  for (const range of ranges) {
    if (opts.budgetExceeded()) break;
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
    if (collected.length >= Math.max(minSamples, 6)) break;
    if (collected.length >= MAX_SAMPLES_PER_TEAM) break;
  }

  return dedupeSortTrim(collected);
}

async function readTeamFromKv(
  kv: FfKv,
  teamId: string
): Promise<TeamMatchSample[] | null> {
  try {
    const raw = await kv.get(`${KV_KEY_PREFIX}${teamId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KvTeamPayload;
    if (!parsed?.samples || !Array.isArray(parsed.samples)) return null;
    return dedupeSortTrim(parsed.samples);
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
    const payload: KvTeamPayload = {
      teamId,
      teamName,
      samples,
      cachedAt: Date.now(),
      lookbackDays: WINDOW_DAYS * NUM_WINDOWS,
    };
    await kv.put(`${KV_KEY_PREFIX}${teamId}`, JSON.stringify(payload), {
      expirationTtl: KV_TTL_SECONDS,
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
    ...partial,
  };
}

function emptyBundle(note: string, coverage?: FormCoverage): HistoricBundle {
  return {
    byTeamId: new Map(),
    byTeamName: new Map(),
    leagueAvgGoals: 1.3,
    fetchedAt: Date.now(),
    lookbackDays: WINDOW_DAYS * NUM_WINDOWS,
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
 * 1) Memory cache → 2) Cloudflare KV → 3) HKJC matchResult(teamId) in ~30d windows.
 */

/** Ingest both sides of a historic match into byTeamId. */
export async function loadHistoricForTeams(
  teams: TeamRef[],
  opts?: { budgetMs?: number; priorityIds?: string[]; matchPairs?: Array<[string, string]> }
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

  // 1) Memory
  const needKv: string[] = [];
  for (const id of teamIds) {
    const mem = store.teamCache.get(id);
    if (
      mem &&
      Date.now() < mem.cachedAt + MEMORY_TTL_MS &&
      mem.samples.length
    ) {
      byTeamId.set(id, mem.samples);
    } else {
      needKv.push(id);
    }
  }

  // 2) KV
  const needNetwork: string[] = [];
  if (kv && needKv.length) {
    await mapPool(needKv, Math.min(8, needKv.length), async (id) => {
      const samples = await readTeamFromKv(kv, id);
      if (samples && samples.length > 0) {
        byTeamId.set(id, samples);
        store.teamCache.set(id, { samples, cachedAt: Date.now() });
        teamsFromKv++;
      } else {
        needNetwork.push(id);
      }
    });
  } else {
    needNetwork.push(...needKv);
  }

  // 3) Team-targeted: complete match pairs first (one strong side -> fetch the weak side)
  const sampleCount = (id: string) => byTeamId.get(id)?.length ?? 0;
  const needs = (id: string) => sampleCount(id) < 2;
  const pairBoost = new Map<string, number>();
  for (const pair of opts?.matchPairs || []) {
    const [h, a] = pair;
    const hs = sampleCount(h);
    const as_ = sampleCount(a);
    // One side ready → boost the weak side heavily
    if (hs >= 2 && as_ < 2) pairBoost.set(a, (pairBoost.get(a) || 0) + 10);
    else if (as_ >= 2 && hs < 2) pairBoost.set(h, (pairBoost.get(h) || 0) + 10);
    else if (hs < 2 && as_ < 2) {
      // Both weak — mild boost so the pair stays adjacent
      pairBoost.set(h, (pairBoost.get(h) || 0) + 3);
      pairBoost.set(a, (pairBoost.get(a) || 0) + 3);
    }
  }
  const toFetch = teamIds
    .filter((id) => needs(id))
    .sort((a, b) => {
      const ba = pairBoost.get(a) || 0;
      const bb = pairBoost.get(b) || 0;
      if (ba !== bb) return bb - ba;
      // Prefer teams that already have 1 sample
      return sampleCount(b) - sampleCount(a);
    });

  // Reserve last 4.5s for second-window fills of 1-sample teams
  const firstWaveExceeded = () =>
    Date.now() - started >= budgetMs - 4_500 || budgetExceeded();

  if (toFetch.length && !firstWaveExceeded()) {
    await mapPool(
      toFetch,
      CONCURRENCY,
      async (id) => {
        if (firstWaveExceeded()) return;
        const name = unique.get(id) || id;
        try {
          const samples = await fetchTeamSamplesNetwork(id, {
            budgetExceeded: firstWaveExceeded,
            minSamples: 2,
            windowIndex: 0,
          });
          teamsFetched++;
          if (samples.length > 0) {
            const merged = dedupeSortTrim([
              ...(byTeamId.get(id) || []),
              ...samples,
            ]);
            byTeamId.set(id, merged);
            store.teamCache.set(id, { samples: merged, cachedAt: Date.now() });
            if (kv) await writeTeamToKv(kv, id, name, merged);
          } else if ((byTeamId.get(id)?.length ?? 0) === 0) {
            store.teamCache.set(id, {
              samples: [],
              cachedAt: Date.now() - MEMORY_TTL_MS + 120_000,
            });
          }
        } catch {
          // ignore
        }
      },
      firstWaveExceeded
    );
  }

  // 4) Second window (days 15-28) for teams stuck at exactly 1 sample —
  // unlocks HAD when partner already has ≥2.
  if (!budgetExceeded()) {
    const stuckAtOne = teamIds
      .filter((id) => (byTeamId.get(id)?.length ?? 0) === 1)
      .sort((a, b) => (pairBoost.get(b) || 0) - (pairBoost.get(a) || 0));
    if (stuckAtOne.length) {
      await mapPool(
        stuckAtOne,
        CONCURRENCY,
        async (id) => {
          if (budgetExceeded()) return;
          const name = unique.get(id) || id;
          try {
            const samples = await fetchTeamSamplesNetwork(id, {
              budgetExceeded,
              minSamples: 2,
              windowIndex: 1,
            });
            teamsFetched++;
            if (samples.length > 0) {
              const merged = dedupeSortTrim([
                ...(byTeamId.get(id) || []),
                ...samples,
              ]);
              byTeamId.set(id, merged);
              store.teamCache.set(id, {
                samples: merged,
                cachedAt: Date.now(),
              });
              if (kv) await writeTeamToKv(kv, id, name, merged);
            }
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
  const lookbackDays = WINDOW_DAYS * NUM_WINDOWS;

  const coverage: FormCoverage = {
    teamsRequested: teamIds.length,
    teamsWithForm,
    teamsWithAtLeast2,
    teamsFromKv,
    teamsFetched,
    timedOut,
  };

  let note: string;
  if (teamsWithForm > 0) {
    note = `Team historic: ${teamsWithForm}/${teamIds.length} teams with form (≥2: ${teamsWithAtLeast2}) · ~${lookbackDays}d · kv ${teamsFromKv} · fetched ${teamsFetched}${
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
