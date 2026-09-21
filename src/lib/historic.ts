import { FootballAPI } from "hkjc-api";
import { formatHktDate } from "./time";

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

export interface HistoricBundle {
  byTeamId: Map<string, TeamMatchSample[]>;
  leagueAvgGoals: number;
  fetchedAt: number;
  lookbackDays: number;
  matchCount: number;
  ok: boolean;
  note: string;
}

const TTL_MS = 20 * 60 * 1000;
const LOOKBACK_DAYS = 28;
const MAX_PER_DAY = 40;
const PAGE = 20;
const CONCURRENCY = 5;
const MAX_SAMPLES_PER_TEAM = 12;

type HistoricGlobal = {
  cache: HistoricBundle | null;
  inflight: Promise<HistoricBundle> | null;
};

const g = globalThis as typeof globalThis & { __ffHistoric?: HistoricGlobal };
if (!g.__ffHistoric) {
  g.__ffHistoric = { cache: null, inflight: null };
}

function getStore(): HistoricGlobal {
  return g.__ffHistoric!;
}

function hktDaysBack(n: number): string[] {
  const days: string[] = [];
  const now = Date.now();
  for (let i = 1; i <= n; i++) {
    days.push(formatHktDate(new Date(now - i * 86400000)));
  }
  return days;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
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

type RawHistoric = {
  id?: string;
  matchDate?: string;
  homeTeam?: { id?: string; name_en?: string };
  awayTeam?: { id?: string; name_en?: string };
  results?: Array<{
    homeResult?: number;
    awayResult?: number;
    ttlCornerResult?: number;
    stageId?: number;
    resultType?: number;
    payoutConfirmed?: boolean;
    sequence?: number;
  }>;
};

function ingestMatch(
  m: RawHistoric,
  byTeamId: Map<string, TeamMatchSample[]>
) {
  if (!m.id || !m.homeTeam?.id || !m.awayTeam?.id) return;
  const ft = pickFullTimeResult(m.results);
  if (!ft) return;
  const date = (m.matchDate || "").slice(0, 10);
  const homeSample: TeamMatchSample = {
    matchId: m.id,
    date,
    isHome: true,
    goalsFor: ft.home,
    goalsAgainst: ft.away,
    result:
      ft.home > ft.away ? "W" : ft.home < ft.away ? "L" : "D",
    totalCorners: ft.corners,
    opponentId: m.awayTeam.id,
    opponentName: m.awayTeam.name_en || "Away",
  };
  const awaySample: TeamMatchSample = {
    matchId: m.id,
    date,
    isHome: false,
    goalsFor: ft.away,
    goalsAgainst: ft.home,
    result:
      ft.away > ft.home ? "W" : ft.away < ft.home ? "L" : "D",
    totalCorners: ft.corners,
    opponentId: m.homeTeam.id,
    opponentName: m.homeTeam.name_en || "Home",
  };
  if (!byTeamId.has(m.homeTeam.id)) byTeamId.set(m.homeTeam.id, []);
  if (!byTeamId.has(m.awayTeam.id)) byTeamId.set(m.awayTeam.id, []);
  byTeamId.get(m.homeTeam.id)!.push(homeSample);
  byTeamId.get(m.awayTeam.id)!.push(awaySample);
}

async function fetchHistoricBundle(): Promise<HistoricBundle> {
  const days = hktDaysBack(LOOKBACK_DAYS);
  const byTeamId = new Map<string, TeamMatchSample[]>();
  const seen = new Set<string>();
  let matchCount = 0;
  let note = "";

  try {
    const api = new FootballAPI();
    const pages = await mapPool(days, CONCURRENCY, async (day) => {
      const out: RawHistoric[] = [];
      for (let start = 0; start < MAX_PER_DAY; start += PAGE) {
        try {
          const r = await api.searchHistoricFootballMatches({
            startDate: day,
            endDate: day,
            startIndex: start,
            endIndex: start + PAGE,
          });
          const batch = (r?.matches || []) as RawHistoric[];
          out.push(...batch);
          const total = r?.matchNumByDate?.total || 0;
          if (batch.length < PAGE || start + PAGE >= total) break;
        } catch {
          break;
        }
      }
      return out;
    });

    for (const batch of pages) {
      for (const m of batch) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        matchCount++;
        ingestMatch(m, byTeamId);
      }
    }

    // Keep newest first, cap per team
    for (const [tid, arr] of byTeamId) {
      arr.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      if (arr.length > MAX_SAMPLES_PER_TEAM) {
        byTeamId.set(tid, arr.slice(0, MAX_SAMPLES_PER_TEAM));
      }
    }

    // League average goals (per team per match ≈ half of match total)
    let goalSum = 0;
    let goalN = 0;
    for (const arr of byTeamId.values()) {
      for (const s of arr) {
        goalSum += s.goalsFor;
        goalN++;
      }
    }
    const leagueAvgGoals = goalN > 0 ? goalSum / goalN : 1.3;

    note =
      matchCount > 0
        ? `Historic form: ${matchCount} matches / ${byTeamId.size} teams (last ${LOOKBACK_DAYS}d)`
        : "Historic HKJC returned no matches; predictions need form samples";

    return {
      byTeamId,
      leagueAvgGoals,
      fetchedAt: Date.now(),
      lookbackDays: LOOKBACK_DAYS,
      matchCount,
      ok: matchCount > 0,
      note,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "historic fetch error";
    return {
      byTeamId: new Map(),
      leagueAvgGoals: 1.3,
      fetchedAt: Date.now(),
      lookbackDays: LOOKBACK_DAYS,
      matchCount: 0,
      ok: false,
      note: `Historic fetch failed (${message}); no form samples for predictions`,
    };
  }
}

/** Process-level cached historic index. Concurrent callers share one inflight fetch. */
export async function getHistoricBundle(): Promise<HistoricBundle> {
  const store = getStore();
  if (store.cache && Date.now() < store.cache.fetchedAt + TTL_MS) {
    return store.cache;
  }
  if (store.inflight) return store.inflight;
  store.inflight = fetchHistoricBundle()
    .then((b) => {
      store.cache = b;
      store.inflight = null;
      return b;
    })
    .catch((err) => {
      store.inflight = null;
      const fallback: HistoricBundle = {
        byTeamId: new Map(),
        leagueAvgGoals: 1.3,
        fetchedAt: Date.now(),
        lookbackDays: LOOKBACK_DAYS,
        matchCount: 0,
        ok: false,
        note: `Historic fetch error: ${err instanceof Error ? err.message : "unknown"}`,
      };
      // Short negative cache so we don't hammer
      store.cache = { ...fallback, fetchedAt: Date.now() - TTL_MS + 60_000 };
      return fallback;
    });
  return store.inflight;
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
  // Weight recent games slightly more
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
    avgScoredHome: home.length ? avg(home.map((s) => s.goalsFor)) : avg(recent.map((s) => s.goalsFor)),
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
  if (!teamId) return null;
  return buildTeamForm(teamId, teamName, bundle.byTeamId.get(teamId));
}
