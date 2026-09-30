/**
 * Unified TeamForm enricher — public fundamental sources only (never odds).
 *
 * Sources (priority for goals/HAD):
 *  1) Existing HKJC samples in HistoricBundle
 *  2) FotMob league fixtures (keyless JSON) — strong for internationals / cups
 *  3) football-data.co.uk season CSVs (keyless) — goals + real HC/AC corners
 *  4) TheSportsDB free search + last event (keyless, thin)
 *  5) OpenLigaDB (DE, keyless)
 *  6) football-data.org v4 when FOOTBALL_DATA_API_KEY set
 *  7) api-football when API_FOOTBALL_KEY set (corners-capable)
 *
 * Corners: prefer real HC/AC / FotMob match stats; else leave null so
 * predictions.ts can use labeled goals/tempo proxy.
 *
 * KV prefixes: extform:v1:*, cornerform:v1:*
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { HistoricBundle, TeamMatchSample, TeamRef } from "./historic";
import { buildTeamForm, getTeamForm } from "./historic";
import { bestNameMatch, normalizeTeamName } from "./team-match";
import type { PredictionSource } from "./types";

const EXT_PREFIX = "extform:v1:";
const KV_TTL_LEAGUE = 6 * 60 * 60; // 6h
const KV_TTL_TEAM = 12 * 60 * 60;
const KV_TTL_CSV = 18 * 60 * 60;
const MAX_SAMPLES = 12;
const FETCH_TIMEOUT_MS = 8_000;
const ENRICH_BUDGET_MS = 14_000;
const CONCURRENCY = 6;

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

/** HKJC tournament code / name → FotMob league id(s) to try. */
const FOTMOB_LEAGUE_MAP: Record<string, number[]> = {
  CNL: [9821],
  E2Q: [10437, 288],
  UCLW: [9375],
  UECW: [11129],
  ANQ: [10608, 289],
  AMF: [9833],
  ELCW: [9717, 9227],
  USL: [8972],
  MLS: [130],
  UD1: [161],
  UDC: [10342],
  CHC: [9091],
  ULP: [11027, 538, 9943],
  INT: [114, 9806, 9807, 9808],
  GULF: [329],
  // name fallbacks keyed lowercased
  "concacaf nations league": [9821],
  "u21 euro qualifiers": [10437],
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

/** football-data.co.uk division codes (current season path mmz4281/2526/). */
const FD_CSV_DIVS = [
  "E0",
  "E1",
  "SP1",
  "D1",
  "I1",
  "F1",
  "N1",
  "P1",
  "SC0",
  "B1",
  "T1",
  "G1",
];

function seasonPath(): string {
  // Aug+ → YY(YY+1); before Aug → (YY-1)YY
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const start = m >= 8 ? y : y - 1;
  const a = String(start).slice(2);
  const b = String(start + 1).slice(2);
  return `${a}${b}`;
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

async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T | null> {
  const text = await fetchText(url, init);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
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
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (h < 0 || a < 0) return null;
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

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
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

function resolveFotmobLeagueIds(leagueCode?: string, league?: string): number[] {
  const out: number[] = [];
  const code = (leagueCode || "").toUpperCase();
  if (code && FOTMOB_LEAGUE_MAP[code]) out.push(...FOTMOB_LEAGUE_MAP[code]);
  const name = (league || "").trim().toLowerCase();
  if (name && FOTMOB_LEAGUE_MAP[name]) out.push(...FOTMOB_LEAGUE_MAP[name]);
  return [...new Set(out)];
}

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

type TeamIndex = Map<string, ExtSample[]>; // normalized name → samples from that team's POV

function parseFotmobScoreStr(scoreStr?: string): { h: number; a: number } | null {
  if (!scoreStr) return null;
  const m = /(\d+)\s*[-:]\s*(\d+)/.exec(scoreStr);
  if (!m) return null;
  return { h: Number(m[1]), a: Number(m[2]) };
}

function ingestFotmobMatches(matches: FotmobMatch[], index: TeamIndex): void {
  for (const m of matches) {
    if (m.notStarted) continue;
    if (m.status && m.status.finished === false) continue;
    // fixtures.allMatches usually has status.scoreStr, not home.score
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
    const homeSample = sampleFromScores(
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
    const awaySample = sampleFromScores(
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
    index.get(homeKey)!.push(homeSample);
    index.get(awayKey)!.push(awaySample);
  }
}

async function loadFotmobLeague(
  leagueId: number,
  kv: FfKv | undefined
): Promise<FotmobMatch[]> {
  const key = `${EXT_PREFIX}fotmob:league:${leagueId}`;
  const cached = await kvGet(kv, key);
  if (cached) {
    try {
      return JSON.parse(cached) as FotmobMatch[];
    } catch {
      // fall through
    }
  }
  const data = await fetchJson<{
    fixtures?: { allMatches?: FotmobMatch[] };
    overview?: { leagueOverviewMatches?: FotmobMatch[]; matches?: { allMatches?: FotmobMatch[] } };
  }>(`https://www.fotmob.com/api/data/leagues?id=${leagueId}`);
  if (!data) return [];
  const matches =
    data.fixtures?.allMatches ||
    data.overview?.matches?.allMatches ||
    data.overview?.leagueOverviewMatches ||
    [];
  const finished = matches.filter((m) => {
    if (m.notStarted) return false;
    if (m.status?.finished === true) return true;
    if (m.home?.score != null && m.away?.score != null) return true;
    if (m.status?.scoreStr && /\d+\s*[-:]\s*\d+/.test(m.status.scoreStr))
      return true;
    return false;
  });
  await kvPut(kv, key, JSON.stringify(finished), KV_TTL_LEAGUE);
  return finished;
}

/** Parse football-data.co.uk CSV — goals + HC/AC only (skip all odds columns). */
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
    // Naive CSV split is OK for these files (team names lack commas)
    const cells = lines[li].split(",");
    const homeName = cells[iHome]?.trim();
    const awayName = cells[iAway]?.trim();
    if (!homeName || !awayName) continue;
    const scores = parseScore(cells[iFTHG], cells[iFTAG]);
    if (!scores) continue;
    let date = (cells[iDate] || "").trim();
    // DD/MM/YYYY → YYYY-MM-DD
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    if (m) date = `${m[3]}-${m[2]}-${m[1]}`;
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
  return index;
}

async function loadFdCsvDiv(
  div: string,
  kv: FfKv | undefined
): Promise<TeamIndex> {
  const season = seasonPath();
  const key = `${EXT_PREFIX}fdcsv:${season}:${div}`;
  const cached = await kvGet(kv, key);
  if (cached) {
    try {
      const obj = JSON.parse(cached) as Record<string, ExtSample[]>;
      return new Map(Object.entries(obj));
    } catch {
      // fall through
    }
  }
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
  const text = await fetchText(url, { timeoutMs: 10_000 });
  if (!text || text.length < 50) return new Map();
  const index = parseFdCsv(text, div);
  const obj: Record<string, ExtSample[]> = {};
  for (const [k, v] of index) obj[k] = dedupeSamples(v);
  await kvPut(kv, key, JSON.stringify(obj), KV_TTL_CSV);
  return index;
}

async function loadTheSportsDbTeam(
  teamName: string,
  kv: FfKv | undefined
): Promise<ExtSample[]> {
  const nkey = normalizeTeamName(teamName);
  const cacheKey = `${EXT_PREFIX}tsdb:team:${nkey}`;
  const cached = await kvGet(kv, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ExtSample[];
    } catch {
      // fall through
    }
  }
  const q = encodeURIComponent(teamName.replace(/\s+/g, "_"));
  const search = await fetchJson<{
    teams?: Array<{
      idTeam?: string;
      strTeam?: string;
      strSport?: string;
      strCountry?: string;
    }> | null;
  }>(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${q}`);
  const teams = (search?.teams || []).filter(
    (t) => (t.strSport || "").toLowerCase() === "soccer"
  );
  if (!teams.length) {
    await kvPut(kv, cacheKey, "[]", KV_TTL_TEAM);
    return [];
  }
  const hit = bestNameMatch(
    teamName,
    teams.map((t) => ({ name: t.strTeam || "", item: t })),
    { minScore: 0.55 }
  );
  if (!hit?.item.idTeam) {
    await kvPut(kv, cacheKey, "[]", KV_TTL_TEAM);
    return [];
  }
  const last = await fetchJson<{
    results?: Array<{
      idEvent?: string;
      dateEvent?: string;
      strHomeTeam?: string;
      strAwayTeam?: string;
      intHomeScore?: string;
      intAwayScore?: string;
      strStatus?: string;
      idHomeTeam?: string;
      idAwayTeam?: string;
    }> | null;
  }>(
    `https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=${hit.item.idTeam}`
  );
  const samples: ExtSample[] = [];
  for (const e of last?.results || []) {
    const scores = parseScore(e.intHomeScore, e.intAwayScore);
    if (!scores) continue;
    const isHome = e.idHomeTeam === hit.item.idTeam;
    const isAway = e.idAwayTeam === hit.item.idTeam;
    if (!isHome && !isAway) {
      // fall back to name
      const hn = normalizeTeamName(e.strHomeTeam || "");
      const homeIs = hn === normalizeTeamName(hit.item.strTeam || teamName);
      samples.push(
        sampleFromScores(
          `tsdb:${e.idEvent}`,
          e.dateEvent || "",
          homeIs,
          homeIs ? scores.h : scores.a,
          homeIs ? scores.a : scores.h,
          null,
          "",
          homeIs ? e.strAwayTeam || "" : e.strHomeTeam || "",
          "thesportsdb"
        )
      );
      continue;
    }
    samples.push(
      sampleFromScores(
        `tsdb:${e.idEvent}`,
        e.dateEvent || "",
        isHome,
        isHome ? scores.h : scores.a,
        isHome ? scores.a : scores.h,
        null,
        isHome ? e.idAwayTeam || "" : e.idHomeTeam || "",
        isHome ? e.strAwayTeam || "" : e.strHomeTeam || "",
        "thesportsdb"
      )
    );
  }
  const trimmed = dedupeSamples(samples);
  await kvPut(kv, cacheKey, JSON.stringify(trimmed), KV_TTL_TEAM);
  return trimmed;
}

async function loadOpenLigaBl(kv: FfKv | undefined): Promise<TeamIndex> {
  const key = `${EXT_PREFIX}openliga:bl1`;
  const cached = await kvGet(kv, key);
  if (cached) {
    try {
      const obj = JSON.parse(cached) as Record<string, ExtSample[]>;
      return new Map(Object.entries(obj));
    } catch {
      // fall through
    }
  }
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
  const year = new Date().getUTCFullYear();
  let data = await fetchJson<OlMatch[]>(
    `https://api.openligadb.de/getmatchdata/bl1/${year}`
  );
  if (!data?.length) {
    data = await fetchJson<OlMatch[]>(
      `https://api.openligadb.de/getmatchdata/bl1/${year - 1}`
    );
  }
  const index: TeamIndex = new Map();
  for (const m of data || []) {
    if (!m.matchIsFinished) continue;
    const ft =
      (m.matchResults || []).find((r) => r.resultTypeId === 2) ||
      (m.matchResults || []).find((r) =>
        (r.resultName || "").toLowerCase().includes("end")
      ) ||
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
  const obj: Record<string, ExtSample[]> = {};
  for (const [k, v] of index) obj[k] = dedupeSamples(v);
  await kvPut(kv, key, JSON.stringify(obj), KV_TTL_LEAGUE);
  return index;
}

async function loadFootballDataOrgTeam(
  teamName: string,
  apiKey: string,
  kv: FfKv | undefined
): Promise<ExtSample[]> {
  const nkey = normalizeTeamName(teamName);
  const cacheKey = `${EXT_PREFIX}fdorg:team:${nkey}`;
  const cached = await kvGet(kv, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ExtSample[];
    } catch {
      // fall through
    }
  }
  const search = await fetchJson<{
    teams?: Array<{ id?: number; name?: string; shortName?: string }>;
  }>(
    `https://api.football-data.org/v4/teams?name=${encodeURIComponent(teamName)}&limit=10`,
    { headers: { "X-Auth-Token": apiKey } }
  );
  const teams = search?.teams || [];
  const hit = bestNameMatch(
    teamName,
    teams.map((t) => ({ name: t.name || t.shortName || "", item: t })),
    { minScore: 0.55 }
  );
  if (!hit?.item.id) {
    await kvPut(kv, cacheKey, "[]", KV_TTL_TEAM);
    return [];
  }
  const matches = await fetchJson<{
    matches?: Array<{
      id?: number;
      utcDate?: string;
      status?: string;
      homeTeam?: { id?: number; name?: string };
      awayTeam?: { id?: number; name?: string };
      score?: { fullTime?: { home?: number | null; away?: number | null } };
    }>;
  }>(
    `https://api.football-data.org/v4/teams/${hit.item.id}/matches?status=FINISHED&limit=12`,
    { headers: { "X-Auth-Token": apiKey } }
  );
  const samples: ExtSample[] = [];
  for (const m of matches?.matches || []) {
    const ft = m.score?.fullTime;
    if (ft?.home == null || ft?.away == null) continue;
    const isHome = m.homeTeam?.id === hit.item.id;
    samples.push(
      sampleFromScores(
        `fdorg:${m.id}`,
        (m.utcDate || "").slice(0, 10),
        isHome,
        isHome ? ft.home : ft.away,
        isHome ? ft.away : ft.home,
        null,
        String((isHome ? m.awayTeam?.id : m.homeTeam?.id) ?? ""),
        (isHome ? m.awayTeam?.name : m.homeTeam?.name) || "",
        "football-data-org"
      )
    );
  }
  const trimmed = dedupeSamples(samples);
  await kvPut(kv, cacheKey, JSON.stringify(trimmed), KV_TTL_TEAM);
  return trimmed;
}

async function loadApiFootballTeam(
  teamName: string,
  apiKey: string,
  kv: FfKv | undefined
): Promise<ExtSample[]> {
  const nkey = normalizeTeamName(teamName);
  const cacheKey = `${EXT_PREFIX}apifb:team:${nkey}`;
  const cached = await kvGet(kv, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as ExtSample[];
    } catch {
      // fall through
    }
  }
  const search = await fetchJson<{
    response?: Array<{ team?: { id?: number; name?: string } }>;
  }>(`https://v3.football.api-sports.io/teams?search=${encodeURIComponent(teamName)}`, {
    headers: { "x-apisports-key": apiKey },
  });
  const teams = (search?.response || [])
    .map((r) => r.team)
    .filter(Boolean) as Array<{ id?: number; name?: string }>;
  const hit = bestNameMatch(
    teamName,
    teams.map((t) => ({ name: t.name || "", item: t })),
    { minScore: 0.55 }
  );
  if (!hit?.item.id) {
    await kvPut(kv, cacheKey, "[]", KV_TTL_TEAM);
    return [];
  }
  const season = new Date().getUTCFullYear();
  const fixtures = await fetchJson<{
    response?: Array<{
      fixture?: { id?: number; date?: string };
      teams?: {
        home?: { id?: number; name?: string };
        away?: { id?: number; name?: string };
      };
      goals?: { home?: number | null; away?: number | null };
    }>;
  }>(
    `https://v3.football.api-sports.io/fixtures?team=${hit.item.id}&last=10`,
    { headers: { "x-apisports-key": apiKey } }
  );
  void season;
  const samples: ExtSample[] = [];
  for (const row of fixtures?.response || []) {
    const g = row.goals;
    if (g?.home == null || g?.away == null) continue;
    const isHome = row.teams?.home?.id === hit.item.id;
    // Optional: statistics for corners (extra request) — skip here for budget;
    // corners-external can deepen later when key present.
    samples.push(
      sampleFromScores(
        `apifb:${row.fixture?.id}`,
        (row.fixture?.date || "").slice(0, 10),
        !!isHome,
        isHome ? g.home : g.away,
        isHome ? g.away : g.home,
        null,
        String((isHome ? row.teams?.away?.id : row.teams?.home?.id) ?? ""),
        (isHome ? row.teams?.away?.name : row.teams?.home?.name) || "",
        "api-football"
      )
    );
  }
  const trimmed = dedupeSamples(samples);
  await kvPut(kv, cacheKey, JSON.stringify(trimmed), KV_TTL_TEAM);
  return trimmed;
}

function lookupInIndex(
  teamName: string,
  index: TeamIndex,
  leagueHint?: string
): ExtSample[] {
  const candidates = [...index.keys()].map((name) => ({
    name,
    item: name,
    hint: leagueHint,
  }));
  const hit = bestNameMatch(teamName, candidates, {
    minScore: 0.58,
    leagueHint,
  });
  if (!hit) return [];
  return dedupeSamples(index.get(hit.item) || []);
}

function mergeSamples(
  existing: TeamMatchSample[] | undefined,
  extra: ExtSample[]
): TeamMatchSample[] {
  return dedupeSamples([...(existing || []), ...extra]);
}

function collectSources(samples: TeamMatchSample[]): PredictionSource[] {
  const set = new Set<PredictionSource>();
  set.add("hkjc");
  for (const s of samples) {
    const src = (s as ExtSample).source;
    if (src) set.add(src);
  }
  if (samples.length) set.add("form");
  return [...set];
}

/**
 * Enrich historic bundle with external fundamental form.
 * Mutates and returns the same bundle reference.
 */
export async function enrichHistoricWithExternal(
  bundle: HistoricBundle,
  teams: ExtTeamRef[],
  opts?: { budgetMs?: number }
): Promise<{ bundle: HistoricBundle; stats: ExtEnrichStats }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const budgetMs = opts?.budgetMs ?? ENRICH_BUDGET_MS;
  const started = Date.now();
  const budgetExceeded = () => Date.now() - started >= budgetMs;

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

  // Prioritize thin / missing form
  const thin = teamList
    .map((t) => ({
      team: t,
      n: bundle.byTeamId.get(t.id)?.length ?? 0,
    }))
    .sort((a, b) => a.n - b.n);

  // --- 1) FotMob league batch (covers many thin internationals at once) ---
  const leagueIds = new Set<number>();
  for (const { team } of thin) {
    for (const id of resolveFotmobLeagueIds(team.leagueCode, team.league)) {
      leagueIds.add(id);
    }
  }
  const fotmobIndex: TeamIndex = new Map();
  const leagueIdList = [...leagueIds].slice(0, 12);
  await mapPool(
    leagueIdList,
    4,
    async (lid) => {
      if (budgetExceeded()) return;
      const matches = await loadFotmobLeague(lid, kv);
      if (matches.length) {
        stats.fotmobLeagues++;
        sourcesUsed.add("fotmob");
        ingestFotmobMatches(matches, fotmobIndex);
      }
    },
    budgetExceeded
  );

  // Merge FotMob into thin teams
  for (const { team, n } of thin) {
    if (budgetExceeded()) break;
    const extra = lookupInIndex(team.name, fotmobIndex, team.league);
    if (!extra.length) continue;
    const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
    if (merged.length > n) {
      bundle.byTeamId.set(team.id, merged);
      const nk = team.name.trim().toLowerCase();
      if (nk) bundle.byTeamName.set(nk, merged);
      stats.teamsEnriched++;
    }
    stats.teamsTouched++;
  }

  // --- 2) football-data.co.uk CSVs (real corners for major clubs) ---
  if (!budgetExceeded()) {
    const csvIndex: TeamIndex = new Map();
    await mapPool(
      FD_CSV_DIVS.slice(0, 8),
      3,
      async (div) => {
        if (budgetExceeded()) return;
        const idx = await loadFdCsvDiv(div, kv);
        if (!idx.size) return;
        stats.csvDivisions++;
        sourcesUsed.add("football-data");
        for (const [k, v] of idx) {
          if (!csvIndex.has(k)) csvIndex.set(k, []);
          csvIndex.get(k)!.push(...v);
        }
      },
      budgetExceeded
    );
    for (const { team } of thin) {
      if (budgetExceeded()) break;
      const extra = lookupInIndex(team.name, csvIndex, team.league);
      if (!extra.length) continue;
      const before = bundle.byTeamId.get(team.id)?.length ?? 0;
      const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
      bundle.byTeamId.set(team.id, merged);
      const nk = team.name.trim().toLowerCase();
      if (nk) bundle.byTeamName.set(nk, merged);
      if (merged.length > before) stats.teamsEnriched++;
    }
  }

  // --- 3) OpenLigaDB (German) ---
  if (!budgetExceeded()) {
    try {
      const ol = await loadOpenLigaBl(kv);
      if (ol.size) {
        stats.openligadb++;
        sourcesUsed.add("openligadb");
        for (const { team } of thin) {
          const extra = lookupInIndex(team.name, ol);
          if (!extra.length) continue;
          const before = bundle.byTeamId.get(team.id)?.length ?? 0;
          const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
          bundle.byTeamId.set(team.id, merged);
          if (merged.length > before) stats.teamsEnriched++;
        }
      }
    } catch {
      // ignore
    }
  }

  // --- 4) TheSportsDB for still-thin teams (1 last event — better than 0) ---
  const stillThin = thin
    .filter(({ team }) => (bundle.byTeamId.get(team.id)?.length ?? 0) < 2)
    .slice(0, 24);
  if (!budgetExceeded() && stillThin.length) {
    await mapPool(
      stillThin,
      CONCURRENCY,
      async ({ team }) => {
        if (budgetExceeded()) return;
        try {
          const extra = await loadTheSportsDbTeam(team.name, kv);
          if (!extra.length) return;
          sourcesUsed.add("thesportsdb");
          stats.thesportsdb++;
          const before = bundle.byTeamId.get(team.id)?.length ?? 0;
          const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
          bundle.byTeamId.set(team.id, merged);
          const nk = team.name.trim().toLowerCase();
          if (nk) bundle.byTeamName.set(nk, merged);
          if (merged.length > before) stats.teamsEnriched++;
        } catch {
          // ignore
        }
      },
      budgetExceeded
    );
  }

  // --- 5) Optional football-data.org ---
  const fdKey = env?.FOOTBALL_DATA_API_KEY;
  if (fdKey && !budgetExceeded()) {
    const need = thin
      .filter(({ team }) => (bundle.byTeamId.get(team.id)?.length ?? 0) < 2)
      .slice(0, 10);
    await mapPool(
      need,
      3,
      async ({ team }) => {
        if (budgetExceeded()) return;
        try {
          const extra = await loadFootballDataOrgTeam(team.name, fdKey, kv);
          if (!extra.length) return;
          sourcesUsed.add("football-data-org");
          stats.footballDataOrg++;
          const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
          bundle.byTeamId.set(team.id, merged);
        } catch {
          // ignore
        }
      },
      budgetExceeded
    );
  }

  // --- 6) Optional api-football ---
  const afKey = env?.API_FOOTBALL_KEY;
  if (afKey && !budgetExceeded()) {
    const need = thin
      .filter(({ team }) => (bundle.byTeamId.get(team.id)?.length ?? 0) < 2)
      .slice(0, 8);
    await mapPool(
      need,
      2,
      async ({ team }) => {
        if (budgetExceeded()) return;
        try {
          const extra = await loadApiFootballTeam(team.name, afKey, kv);
          if (!extra.length) return;
          sourcesUsed.add("api-football");
          stats.apiFootball++;
          const merged = mergeSamples(bundle.byTeamId.get(team.id), extra);
          bundle.byTeamId.set(team.id, merged);
        } catch {
          // ignore
        }
      },
      budgetExceeded
    );
  }

  stats.timedOut = budgetExceeded();
  stats.sourcesUsed = [...sourcesUsed];

  // Recompute coverage + league avg
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
      : "";
  bundle.note = `${bundle.note || "Historic"}${srcNote}${
    stats.timedOut ? " · ext partial (budget)" : ""
  }`;

  return { bundle, stats };
}

/** Attach source chips onto TeamForm via samples' provenance. */
export function teamFormSources(
  bundle: HistoricBundle,
  teamId: string | undefined,
  teamName: string
): PredictionSource[] {
  const form = getTeamForm(bundle, teamId, teamName);
  if (!form) return [];
  return collectSources(form.samples);
}

export { buildTeamForm, collectSources };
