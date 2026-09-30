/**
 * Unified TeamForm enricher — public fundamental sources only (never odds).
 *
 * Free Workers cannot JSON-parse multiple large FotMob dumps inside /api/matches
 * (CPU 1102). Architecture:
 *  - /api/warm-ext populates KV `extform:v2:fotmob:league:{id}` / CSV indexes
 *  - enrichHistoricWithExternal only READs KV + merges into HistoricBundle
 *
 * Sources: fotmob (warmed), football-data.co.uk CSV (warmed), openligadb (warmed).
 * TheSportsDB returns 429 from CF IPs — skipped.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { HistoricBundle, TeamMatchSample, TeamRef } from "./historic";
import { buildTeamForm, getTeamForm } from "./historic";
import { bestNameMatch, normalizeTeamName } from "./team-match";
import type { PredictionSource } from "./types";

const EXT_PREFIX = "extform:v2:";
const KV_TTL_LEAGUE = 6 * 60 * 60;
const KV_TTL_CSV = 18 * 60 * 60;
const MAX_SAMPLES = 12;
const FETCH_TIMEOUT_MS = 10_000;
const FOTMOB_MAX_BYTES = 560_000;

export type ExtTeamRef = TeamRef & {
  league?: string;
  leagueCode?: string;
};

export type ExtEnrichStats = {
  teamsEnriched: number;
  teamsTouched: number;
  fotmobLeagues: number;
  csvDivisions: number;
  thesportsdb: number;
  openligadb: number;
  footballDataOrg: number;
  apiFootball: number;
  timedOut: boolean;
  sourcesUsed: string[];
};

type FfKv = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
};

type ExtEnv = {
  HISTORIC_CACHE?: FfKv;
  FOOTBALL_DATA_API_KEY?: string;
  API_FOOTBALL_KEY?: string;
};

type ExtSample = TeamMatchSample & { source?: PredictionSource };
type TeamIndex = Map<string, ExtSample[]>;

type FotmobMatch = {
  id?: string | number;
  home?: { id?: string | number; name?: string; score?: number };
  away?: { id?: string | number; name?: string; score?: number };
  status?: {
    finished?: boolean;
    utcTime?: string;
    scoreStr?: string;
  };
  notStarted?: boolean;
};

const FOTMOB_LEAGUE_MAP: Record<string, number[]> = {
  CNL: [9821],
  E2Q: [288, 10437],
  UCLW: [9375],
  UECW: [11129],
  ANQ: [10608],
  AMF: [9833],
  ELCW: [9717, 9227],
  USL: [8972],
  MLS: [130],
  UD1: [161],
  UDC: [10342],
  CHC: [9091],
  ULP: [11027, 538],
  INT: [114],
  GULF: [329],
  "concacaf nations league": [9821],
  "u21 euro qualifiers": [10437, 288],
  "women ue champions": [9375],
  "women europa cup": [11129],
  "africa cup of nations qualifiers": [10608],
  "asian games men": [9833],
  "women english league cup": [9717],
  "usl championship": [8972],
  "us major league": [130],
  "uruguayan division 1": [161],
  "uruguayan cup": [10342],
  "chilean cup": [9091],
  "uae league cup": [11027],
  "international matches": [114],
  "gulf cup": [329],
};

/** Warm-friendly leagues (size-checked at fetch). */
export const WARM_FOTMOB_LEAGUES: Array<{ id: number; label: string }> = [
  { id: 329, label: "Gulf Cup" },
  { id: 11027, label: "UAE League Cup" },
  { id: 10342, label: "Copa Uruguay" },
  { id: 9833, label: "Asian Games" },
  { id: 9375, label: "Women's CL" },
  { id: 9717, label: "Women's League Cup" },
  { id: 11129, label: "Women's Europa Cup" },
  { id: 9091, label: "Copa Chile" },
  { id: 9821, label: "CONCACAF Nations League" },
  { id: 288, label: "EURO U21" },
  { id: 9227, label: "WSL" },
  { id: 10608, label: "AFCON Qual" },
  { id: 114, label: "Friendlies" },
  { id: 10437, label: "EURO U21 Qual" },
  { id: 161, label: "Uruguay Liga" },
  { id: 8972, label: "USL Championship" },
  { id: 130, label: "MLS" },
];

const FD_CSV_DIVS = ["E0", "E1", "SP1", "D1", "I1", "F1"];

function seasonPath(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const start = m >= 8 ? y : y - 1;
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
}

async function getEnv(): Promise<ExtEnv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    return (ctx?.env as ExtEnv | undefined) ?? null;
  } catch {
    return null;
  }
}

async function fetchText(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<string | null> {
  const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "FootballFanatics/1.0 (+fundamental-form; never-odds; Cloudflare Workers)",
        Accept: "application/json,text/csv,text/plain,*/*",
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function kvGet(kv: FfKv | undefined, key: string): Promise<string | null> {
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function kvPut(
  kv: FfKv | undefined,
  key: string,
  value: string,
  ttl: number
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(key, value, { expirationTtl: ttl });
  } catch {
    // ignore
  }
}

function dedupeSamples(samples: ExtSample[]): ExtSample[] {
  const seen = new Set<string>();
  const out: ExtSample[] = [];
  for (const s of samples) {
    const key = `${s.matchId}:${s.isHome ? "H" : "A"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, MAX_SAMPLES);
}

function parseScore(home: unknown, away: unknown): { h: number; a: number } | null {
  const h = Number(home);
  const a = Number(away);
  if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) return null;
  return { h, a };
}

function sampleFromScores(
  matchId: string,
  date: string,
  isHome: boolean,
  goalsFor: number,
  goalsAgainst: number,
  totalCorners: number | null,
  opponentId: string,
  opponentName: string,
  source: PredictionSource
): ExtSample {
  return {
    matchId,
    date: (date || "").slice(0, 10),
    isHome,
    goalsFor,
    goalsAgainst,
    result: goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D",
    totalCorners,
    opponentId,
    opponentName,
    source,
  };
}

function parseFotmobScoreStr(scoreStr?: string): { h: number; a: number } | null {
  if (!scoreStr) return null;
  const m = /(\d+)\s*[-:]\s*(\d+)/.exec(scoreStr);
  if (!m) return null;
  return { h: Number(m[1]), a: Number(m[2]) };
}

function indexFromFotmobMatches(matches: FotmobMatch[]): TeamIndex {
  const index: TeamIndex = new Map();
  for (const m of matches) {
    if (m.notStarted) continue;
    if (m.status && m.status.finished === false) continue;
    let h: number | null =
      m.home?.score != null && Number.isFinite(Number(m.home.score))
        ? Number(m.home.score)
        : null;
    let a: number | null =
      m.away?.score != null && Number.isFinite(Number(m.away.score))
        ? Number(m.away.score)
        : null;
    if (h == null || a == null) {
      const parsed = parseFotmobScoreStr(m.status?.scoreStr);
      if (!parsed) continue;
      h = parsed.h;
      a = parsed.a;
    }
    const homeName = m.home?.name || "";
    const awayName = m.away?.name || "";
    if (!homeName || !awayName) continue;
    const date = (m.status?.utcTime || "").slice(0, 10);
    const mid = `fotmob:${m.id ?? `${homeName}-${awayName}-${date}`}`;
    const homeKey = normalizeTeamName(homeName);
    const awayKey = normalizeTeamName(awayName);
    const hs = sampleFromScores(
      mid,
      date,
      true,
      h,
      a,
      null,
      String(m.away?.id ?? ""),
      awayName,
      "fotmob"
    );
    const as = sampleFromScores(
      mid,
      date,
      false,
      a,
      h,
      null,
      String(m.home?.id ?? ""),
      homeName,
      "fotmob"
    );
    if (!index.has(homeKey)) index.set(homeKey, []);
    if (!index.has(awayKey)) index.set(awayKey, []);
    index.get(homeKey)!.push(hs);
    index.get(awayKey)!.push(as);
  }
  for (const [k, v] of index) index.set(k, dedupeSamples(v));
  return index;
}

function parseFdCsv(text: string, div: string): TeamIndex {
  const index: TeamIndex = new Map();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return index;
  const header = lines[0].split(",");
  const col = (name: string) => header.indexOf(name);
  const iHome = col("HomeTeam");
  const iAway = col("AwayTeam");
  const iFTHG = col("FTHG");
  const iFTAG = col("FTAG");
  const iDate = col("Date");
  const iHC = col("HC");
  const iAC = col("AC");
  if (iHome < 0 || iAway < 0 || iFTHG < 0 || iFTAG < 0) return index;

  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(",");
    const homeName = cells[iHome]?.trim();
    const awayName = cells[iAway]?.trim();
    if (!homeName || !awayName) continue;
    const scores = parseScore(cells[iFTHG], cells[iFTAG]);
    if (!scores) continue;
    let date = (cells[iDate] || "").trim();
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}`;
    const hc = iHC >= 0 ? Number(cells[iHC]) : NaN;
    const ac = iAC >= 0 ? Number(cells[iAC]) : NaN;
    const totalCorners =
      Number.isFinite(hc) && Number.isFinite(ac) && hc >= 0 && ac >= 0
        ? hc + ac
        : null;
    const mid = `fdcsv:${div}:${date}:${homeName}:${awayName}`;
    const homeKey = normalizeTeamName(homeName);
    const awayKey = normalizeTeamName(awayName);
    const hs = sampleFromScores(
      mid,
      date,
      true,
      scores.h,
      scores.a,
      totalCorners,
      awayKey,
      awayName,
      "football-data"
    );
    const as = sampleFromScores(
      mid,
      date,
      false,
      scores.a,
      scores.h,
      totalCorners,
      homeKey,
      homeName,
      "football-data"
    );
    if (!index.has(homeKey)) index.set(homeKey, []);
    if (!index.has(awayKey)) index.set(awayKey, []);
    index.get(homeKey)!.push(hs);
    index.get(awayKey)!.push(as);
  }
  for (const [k, v] of index) index.set(k, dedupeSamples(v));
  return index;
}

function indexToObject(index: TeamIndex): Record<string, ExtSample[]> {
  const obj: Record<string, ExtSample[]> = {};
  for (const [k, v] of index) obj[k] = v;
  return obj;
}

function objectToIndex(obj: Record<string, ExtSample[]>): TeamIndex {
  return new Map(Object.entries(obj));
}

function lookupInIndex(
  teamName: string,
  index: TeamIndex,
  leagueHint?: string
): ExtSample[] {
  const exact = normalizeTeamName(teamName);
  if (index.has(exact)) return dedupeSamples(index.get(exact) || []);
  // Alias / fuzzy only over a capped candidate list
  const keys = [...index.keys()];
  if (keys.length > 80) {
    // Prefer keys that share a token prefix to keep CPU bounded
    const tok = exact.split(" ").filter(Boolean)[0] || exact;
    const narrowed = keys.filter((k) => k.includes(tok)).slice(0, 40);
    const pool = narrowed.length ? narrowed : keys.slice(0, 40);
    const hit = bestNameMatch(
      teamName,
      pool.map((name) => ({ name, item: name, hint: leagueHint })),
      { minScore: 0.62, leagueHint }
    );
    if (!hit) return [];
    return dedupeSamples(index.get(hit.item) || []);
  }
  const hit = bestNameMatch(
    teamName,
    keys.map((name) => ({ name, item: name, hint: leagueHint })),
    { minScore: 0.58, leagueHint }
  );
  if (!hit) return [];
  return dedupeSamples(index.get(hit.item) || []);
}

function mergeSamples(
  existing: TeamMatchSample[] | undefined,
  extra: ExtSample[]
): TeamMatchSample[] {
  return dedupeSamples([...(existing || []), ...extra]);
}

function resolveFotmobLeagueIds(leagueCode?: string, league?: string): number[] {
  const out: number[] = [];
  const code = (leagueCode || "").toUpperCase();
  if (code && FOTMOB_LEAGUE_MAP[code]) out.push(...FOTMOB_LEAGUE_MAP[code]);
  const name = (league || "").trim().toLowerCase();
  if (name && FOTMOB_LEAGUE_MAP[name]) out.push(...FOTMOB_LEAGUE_MAP[name]);
  return [...new Set(out)];
}

/** Warm one FotMob league into KV (call from /api/warm-ext, not matches). */
export async function warmFotmobLeague(
  leagueId: number
): Promise<{ ok: boolean; teams: number; matches: number; bytes: number; skipped?: string }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const key = `${EXT_PREFIX}fotmob:idx:${leagueId}`;
  const rawText = await fetchText(
    `https://www.fotmob.com/api/data/leagues?id=${leagueId}`,
    { timeoutMs: 12_000 }
  );
  if (!rawText) return { ok: false, teams: 0, matches: 0, bytes: 0, skipped: "fetch-failed" };
  if (rawText.length > FOTMOB_MAX_BYTES) {
    return {
      ok: false,
      teams: 0,
      matches: 0,
      bytes: rawText.length,
      skipped: `too-large:${rawText.length}`,
    };
  }
  let payload: {
    fixtures?: { allMatches?: FotmobMatch[] };
    overview?: {
      leagueOverviewMatches?: FotmobMatch[];
      matches?: { allMatches?: FotmobMatch[] };
    };
  };
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { ok: false, teams: 0, matches: 0, bytes: rawText.length, skipped: "bad-json" };
  }
  const matches =
    payload.fixtures?.allMatches ||
    payload.overview?.matches?.allMatches ||
    payload.overview?.leagueOverviewMatches ||
    [];
  const finished = matches.filter((m) => {
    if (m.notStarted) return false;
    if (m.status?.finished === true) return true;
    if (m.status?.scoreStr) return true;
    return m.home?.score != null && m.away?.score != null;
  });
  const compact = finished.slice(-60).map((m) => ({
    id: m.id,
    home: m.home
      ? { id: m.home.id, name: m.home.name, score: m.home.score }
      : undefined,
    away: m.away
      ? { id: m.away.id, name: m.away.name, score: m.away.score }
      : undefined,
    status: {
      finished: m.status?.finished,
      utcTime: m.status?.utcTime,
      scoreStr: m.status?.scoreStr,
    },
  }));
  const index = indexFromFotmobMatches(compact);
  await kvPut(kv, key, JSON.stringify(indexToObject(index)), KV_TTL_LEAGUE);
  return {
    ok: true,
    teams: index.size,
    matches: compact.length,
    bytes: rawText.length,
  };
}

/** Warm one football-data.co.uk CSV division into KV. */
export async function warmFdCsvDiv(
  div: string
): Promise<{ ok: boolean; teams: number; bytes: number }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const season = seasonPath();
  const key = `${EXT_PREFIX}fdcsv:${season}:${div}`;
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
  const text = await fetchText(url, { timeoutMs: 12_000 });
  if (!text || text.length < 50) return { ok: false, teams: 0, bytes: 0 };
  const index = parseFdCsv(text, div);
  await kvPut(kv, key, JSON.stringify(indexToObject(index)), KV_TTL_CSV);
  return { ok: true, teams: index.size, bytes: text.length };
}

export async function warmOpenLiga(): Promise<{ ok: boolean; teams: number }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const year = new Date().getUTCFullYear();
  const text =
    (await fetchText(`https://api.openligadb.de/getmatchdata/bl1/${year}`)) ||
    (await fetchText(`https://api.openligadb.de/getmatchdata/bl1/${year - 1}`));
  if (!text) return { ok: false, teams: 0 };
  type OlMatch = {
    matchID?: number;
    matchDateTimeUTC?: string;
    matchIsFinished?: boolean;
    team1?: { teamName?: string; teamId?: number };
    team2?: { teamName?: string; teamId?: number };
    matchResults?: Array<{
      pointsTeam1?: number;
      pointsTeam2?: number;
      resultTypeId?: number;
      resultName?: string;
    }>;
  };
  let data: OlMatch[] = [];
  try {
    data = JSON.parse(text) as OlMatch[];
  } catch {
    return { ok: false, teams: 0 };
  }
  const index: TeamIndex = new Map();
  for (const m of data) {
    if (!m.matchIsFinished) continue;
    const ft =
      (m.matchResults || []).find((r) => r.resultTypeId === 2) ||
      (m.matchResults || [])[(m.matchResults || []).length - 1];
    if (!ft || ft.pointsTeam1 == null || ft.pointsTeam2 == null) continue;
    const homeName = m.team1?.teamName || "";
    const awayName = m.team2?.teamName || "";
    if (!homeName || !awayName) continue;
    const date = (m.matchDateTimeUTC || "").slice(0, 10);
    const mid = `openliga:${m.matchID}`;
    const homeKey = normalizeTeamName(homeName);
    const awayKey = normalizeTeamName(awayName);
    const hs = sampleFromScores(
      mid,
      date,
      true,
      ft.pointsTeam1,
      ft.pointsTeam2,
      null,
      String(m.team2?.teamId ?? ""),
      awayName,
      "openligadb"
    );
    const as = sampleFromScores(
      mid,
      date,
      false,
      ft.pointsTeam2,
      ft.pointsTeam1,
      null,
      String(m.team1?.teamId ?? ""),
      homeName,
      "openligadb"
    );
    if (!index.has(homeKey)) index.set(homeKey, []);
    if (!index.has(awayKey)) index.set(awayKey, []);
    index.get(homeKey)!.push(hs);
    index.get(awayKey)!.push(as);
  }
  for (const [k, v] of index) index.set(k, dedupeSamples(v));
  await kvPut(
    kv,
    `${EXT_PREFIX}openliga:bl1`,
    JSON.stringify(indexToObject(index)),
    KV_TTL_LEAGUE
  );
  return { ok: true, teams: index.size };
}

async function loadKvIndex(
  kv: FfKv | undefined,
  key: string
): Promise<TeamIndex> {
  const raw = await kvGet(kv, key);
  if (!raw) return new Map();
  try {
    return objectToIndex(JSON.parse(raw) as Record<string, ExtSample[]>);
  } catch {
    return new Map();
  }
}

/**
 * KV-only enrich for /api/matches — no large outbound JSON parse.
 * Warm caches via /api/warm-ext first.
 */
export async function enrichHistoricWithExternal(
  bundle: HistoricBundle,
  teams: ExtTeamRef[],
  _opts?: { budgetMs?: number }
): Promise<{ bundle: HistoricBundle; stats: ExtEnrichStats }> {
  void _opts;
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const stats: ExtEnrichStats = {
    teamsEnriched: 0,
    teamsTouched: 0,
    fotmobLeagues: 0,
    csvDivisions: 0,
    thesportsdb: 0,
    openligadb: 0,
    footballDataOrg: 0,
    apiFootball: 0,
    timedOut: false,
    sourcesUsed: [],
  };
  const sourcesUsed = new Set<string>();

  const unique = new Map<string, ExtTeamRef>();
  for (const t of teams) {
    if (!t?.id) continue;
    if (!unique.has(t.id)) unique.set(t.id, t);
  }
  const teamList = [...unique.values()];
  const thin = teamList
    .map((t) => ({ team: t, n: bundle.byTeamId.get(t.id)?.length ?? 0 }))
    .filter((x) => x.n < 2)
    .sort((a, b) => a.n - b.n);

  // Only load leagues demanded by *this card* (cap KV JSON parses for Free CPU)
  const demand = new Map<number, number>();
  for (const { team } of thin) {
    for (const id of resolveFotmobLeagueIds(team.leagueCode, team.league)) {
      demand.set(id, (demand.get(id) || 0) + 1);
    }
  }
  const leagueIds = [...demand.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  // Prefer likely-warmed small leagues even if lower demand count
  const preferred = [9821, 9375, 11129, 9717, 114, 10608, 9833, 11027, 329, 9091, 10342, 288, 9227, 10437, 161, 8972, 130];
  const ordered = [
    ...preferred.filter((id) => leagueIds.includes(id)),
    ...leagueIds.filter((id) => !preferred.includes(id)),
  ];

  const mergedIndex: TeamIndex = new Map();
  let loaded = 0;
  for (const lid of ordered) {
    if (loaded >= 7) break;
    const idx = await loadKvIndex(kv, `${EXT_PREFIX}fotmob:idx:${lid}`);
    if (!idx.size) continue;
    loaded++;
    stats.fotmobLeagues++;
    sourcesUsed.add("fotmob");
    for (const [k, v] of idx) {
      if (!mergedIndex.has(k)) mergedIndex.set(k, []);
      mergedIndex.get(k)!.push(...v);
    }
  }

  // At most 2 CSV divisions (corners for major EU clubs when names match)
  const season = seasonPath();
  for (const div of FD_CSV_DIVS.slice(0, 1)) {
    const idx = await loadKvIndex(kv, `${EXT_PREFIX}fdcsv:${season}:${div}`);
    if (!idx.size) continue;
    stats.csvDivisions++;
    sourcesUsed.add("football-data");
    for (const [k, v] of idx) {
      if (!mergedIndex.has(k)) mergedIndex.set(k, []);
      mergedIndex.get(k)!.push(...v);
    }
  }

  for (const [k, v] of mergedIndex) mergedIndex.set(k, dedupeSamples(v));

  for (const { team, n } of thin) {
    const extra = lookupInIndex(team.name, mergedIndex, team.league);
    if (!extra.length) continue;
    stats.teamsTouched++;
    const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
    if (merged.length > n) {
      bundle.byTeamId.set(team.id, merged);
      const nk = team.name.trim().toLowerCase();
      if (nk) bundle.byTeamName.set(nk, merged);
      stats.teamsEnriched++;
    }
  }

  stats.sourcesUsed = [...sourcesUsed];

  // Recompute coverage
  let matchCount = 0;
  let goalSum = 0;
  let goalN = 0;
  const teamIds = teamList.map((t) => t.id);
  for (const id of teamIds) {
    const samples = dedupeSamples(bundle.byTeamId.get(id) || []);
    if (samples.length) bundle.byTeamId.set(id, samples);
    else bundle.byTeamId.delete(id);
    matchCount += samples.length;
    for (const s of samples) {
      goalSum += s.goalsFor;
      goalN++;
    }
  }
  const teamsWithForm = teamIds.filter(
    (id) => (bundle.byTeamId.get(id)?.length ?? 0) > 0
  ).length;
  const teamsWithAtLeast2 = teamIds.filter(
    (id) => (bundle.byTeamId.get(id)?.length ?? 0) >= 2
  ).length;
  bundle.matchCount = matchCount;
  bundle.leagueAvgGoals = goalN > 0 ? goalSum / goalN : bundle.leagueAvgGoals;
  bundle.ok = teamsWithForm > 0;
  bundle.formCoverage = {
    ...bundle.formCoverage,
    teamsRequested: teamIds.length,
    teamsWithForm,
    teamsWithAtLeast2,
  };
  const srcNote =
    stats.sourcesUsed.length > 0
      ? ` · ext[${stats.sourcesUsed.join("+")}] +${stats.teamsEnriched}`
      : " · ext[kv-miss: run /api/warm-ext]";
  bundle.note = `${bundle.note || "Historic"}${srcNote}`;

  return { bundle, stats };
}

export function teamFormSources(
  bundle: HistoricBundle,
  teamId: string | undefined,
  teamName: string
): PredictionSource[] {
  const form = getTeamForm(bundle, teamId, teamName);
  if (!form) return [];
  const set = new Set<PredictionSource>(["hkjc", "form"]);
  for (const s of form.samples) {
    const src = (s as ExtSample).source;
    if (src) set.add(src);
  }
  return [...set];
}

export { buildTeamForm };
