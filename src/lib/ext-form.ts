/**
 * Unified TeamForm enricher — public fundamental sources only (never odds).
 *
 * Free Workers cannot JSON-parse multiple large FotMob dumps inside /api/matches
 * (CPU 1102). Architecture:
 *  - /api/warm-ext populates KV `extform:v2:fotmob:idx:{id}` / CSV / openliga indexes
 *  - enrichHistoricWithExternal only READs KV + merges into HistoricBundle
 *
 * Sources: fotmob (warmed), football-data.co.uk CSV (warmed), openligadb (warmed).
 * TheSportsDB returns 429 from CF IPs — skipped.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { HistoricBundle, TeamMatchSample, TeamRef } from "./historic";
import { buildTeamForm, getTeamForm } from "./historic";
import { bestNameMatch, getTeamAliasKeys, normalizeTeamName } from "./team-match";
import { fetchLiveFootballMatches } from "./hkjc-graphql";
import { addDaysHkt, formatHktDate, hktDateFromIso } from "./time";
import type { PredictionSource } from "./types";

const EXT_PREFIX = "extform:v2:";
/** Compact per-board-team form index — /api/matches does O(1) lookups only. */
export const BOARD_TEAMS_KEY = `${EXT_PREFIX}board-teams`;
const KV_TTL_LEAGUE = 6 * 60 * 60;
const KV_TTL_BOARD_TEAMS = 4 * 60 * 60;
const KV_TTL_CSV = 18 * 60 * 60;
const MAX_SAMPLES = 12;
const FETCH_TIMEOUT_MS = 10_000;
/** Soft cap — oversized season dumps still parse on warm up to HARD max. */
const FOTMOB_MAX_BYTES = 560_000;
/** Hard cap even for warm parse attempts. */
const FOTMOB_HARD_MAX_BYTES = 1_050_000;

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
  UDC: [10342, 161], // cup fixtures often unfinished — use Liga form
  CHC: [9091],
  ULP: [11027, 538],
  INT: [114],
  GULF: [329],
  GUC: [329],
  // 2026-10-07 HKJC slate
  JEC: [9011, 223], // Emperor's Cup (+ J1 club form when warmable)
  BD1: [268],
  BD2: [8814],
  FVL: [51, 251], // Veikkausliiga / Ykkösliiga
  QSL: [535],
  CUP: [9469], // AFC Champions League Two (e.g. Kuching vs Tampines)
  KD1W: [], // WK League — no stable small FotMob dump; label unmapped
  "concacaf nations league": [9821],
  "gulf cup": [329],
  "u21 euro qualifiers": [10437, 288],
  "women ue champions": [9375],
  "women europa cup": [11129],
  "africa cup of nations qualifiers": [10608],
  "asian games men": [9833],
  "women english league cup": [9717],
  "usl championship": [8972],
  "us major league": [130],
  "uruguayan division 1": [161],
  "uruguayan cup": [10342, 161],
  "chilean cup": [9091],
  "uae league cup": [11027],
  "international matches": [114],
  "emperor's cup": [9011, 223],
  "emperors cup": [9011, 223],
  "brazilian division 1": [268],
  "brazilian division 2": [8814],
  "finnish division 1": [51, 251],
  "qatar stars league": [535],
  "cup competition": [9469],
  "women korean division 1": [],
};

/** Warm-friendly leagues (size-checked at fetch). */
export const WARM_FOTMOB_LEAGUES: Array<{ id: number; label: string }> = [
  // Prefer leagues that appear on typical HKJC today/tomorrow boards
  { id: 9011, label: "Emperor's Cup (Japan)" },
  { id: 268, label: "Brazil Serie A" },
  { id: 8814, label: "Brazil Serie B" },
  { id: 51, label: "Veikkausliiga" },
  { id: 251, label: "Ykkosliiga" },
  { id: 535, label: "Qatar Stars League" },
  { id: 9469, label: "AFC Champions League Two" },
  { id: 11027, label: "UAE League Cup" },
  { id: 10342, label: "Copa Uruguay" },
  { id: 9091, label: "Copa Chile" },
  { id: 114, label: "Friendlies" },
  { id: 9821, label: "CONCACAF Nations League" },
  { id: 130, label: "MLS" },
  { id: 329, label: "Gulf Cup" },
  { id: 223, label: "J. League" },
  { id: 9833, label: "Asian Games" },
  { id: 9375, label: "Women's CL" },
  { id: 9717, label: "Women's League Cup" },
  { id: 11129, label: "Women's Europa Cup" },
  { id: 288, label: "EURO U21" },
  { id: 9227, label: "WSL" },
  { id: 10608, label: "AFCON Qual" },
  { id: 10437, label: "EURO U21 Qual" },
  { id: 161, label: "Uruguay Liga" },
  { id: 8972, label: "USL Championship" },
];

export const FD_CSV_DIVS = ["E0", "E1", "SP1", "D1", "I1", "F1"];

function seasonPath(offsetYears = 0): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const start = (m >= 8 ? y : y - 1) - offsetYears;
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
}

function seasonCandidates(): string[] {
  const a = seasonPath(0);
  const b = seasonPath(1);
  return a === b ? [a] : [a, b];
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
  leagueHint?: string,
  opts?: { exactOnly?: boolean }
): ExtSample[] {
  const exactOnly = opts?.exactOnly === true;
  // Full alias set (same keys board-teams index is written under)
  for (const key of getTeamAliasKeys(teamName)) {
    if (index.has(key)) return dedupeSamples(index.get(key) || []);
  }
  // Also try bestNameMatch against alias keys already in index when exactOnly
  // uses a tiny pool: only keys that share first token (CPU-safe).
  const exact = normalizeTeamName(teamName);
  const tok = exact.split(" ").filter(Boolean)[0] || exact;
  const keys = [...index.keys()];
  const narrowed = keys.filter((k) => k.includes(tok)).slice(0, exactOnly ? 12 : 40);
  if (narrowed.length) {
    const hit = bestNameMatch(
      teamName,
      narrowed.map((name) => ({ name, item: name, hint: leagueHint })),
      { minScore: exactOnly ? 0.78 : keys.length > 80 ? 0.62 : 0.58, leagueHint }
    );
    if (hit) return dedupeSamples(index.get(hit.item) || []);
  }
  if (exactOnly) return [];
  if (keys.length > 80) return [];
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
  if (rawText.length > FOTMOB_HARD_MAX_BYTES) {
    return {
      ok: false,
      teams: 0,
      matches: 0,
      bytes: rawText.length,
      skipped: `too-large:${rawText.length}`,
    };
  }
  // Soft-oversize dumps still parse once on warm (not on /api/matches).
  const softOversize = rawText.length > FOTMOB_MAX_BYTES;
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
    ...(softOversize ? { skipped: `soft-oversize:${rawText.length}` } : {}),
  };
}

/** Warm one football-data.co.uk CSV division into KV. */
export async function warmFdCsvDiv(
  div: string
): Promise<{ ok: boolean; teams: number; bytes: number; season?: string }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  for (const season of seasonCandidates()) {
    const key = `${EXT_PREFIX}fdcsv:${season}:${div}`;
    const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
    const body = await fetchText(url, { timeoutMs: 12_000 });
    if (!body || body.length < 50 || !body.includes("HomeTeam")) continue;
    const index = parseFdCsv(body, div);
    if (!index.size) continue;
    await kvPut(kv, key, JSON.stringify(indexToObject(index)), KV_TTL_CSV);
    // Also mirror under current season key so enrich seasonPath(0) finds it
    const current = seasonPath(0);
    if (season !== current) {
      await kvPut(
        kv,
        `${EXT_PREFIX}fdcsv:${current}:${div}`,
        JSON.stringify(indexToObject(index)),
        KV_TTL_CSV
      );
    }
    return { ok: true, teams: index.size, bytes: body.length, season };
  }
  return { ok: false, teams: 0, bytes: 0 };
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

/** Date yyyymmdd in UTC for FotMob matches?date= */
function fotmobDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

type DateLeagueHint = {
  ccode?: string;
  nameIncludes: string[];
  nameExcludes?: string[];
};

/** Warm recent results via small daily dumps (for oversized season league JSON). */
export async function warmFotmobByDateHints(
  hints: DateLeagueHint[],
  opts?: { days?: number; kvKey?: string }
): Promise<{ ok: boolean; teams: number; matches: number; days: number }> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const days = Math.max(3, Math.min(28, opts?.days ?? 18));
  const index: TeamIndex = new Map();
  let matchCount = 0;
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const ds = fotmobDateUtc(d);
    const rawText = await fetchText(
      `https://www.fotmob.com/api/data/matches?date=${ds}`,
      { timeoutMs: 10_000 }
    );
    if (!rawText || rawText.length < 20) continue;
    let payload: {
      leagues?: Array<{
        id?: number;
        name?: string;
        ccode?: string;
        matches?: Array<{
          id?: number;
          home?: { id?: number; name?: string; score?: number };
          away?: { id?: number; name?: string; score?: number };
          status?: { finished?: boolean; utcTime?: string; scoreStr?: string };
        }>;
      }>;
    };
    try {
      payload = JSON.parse(rawText);
    } catch {
      continue;
    }
    for (const league of payload.leagues || []) {
      const lname = (league.name || "").toLowerCase();
      const cc = (league.ccode || "").toUpperCase();
      const hit = hints.some((h) => {
        if (h.ccode && h.ccode.toUpperCase() !== cc) return false;
        if (h.nameExcludes?.some((x) => lname.includes(x.toLowerCase()))) return false;
        return h.nameIncludes.some((x) => lname.includes(x.toLowerCase()));
      });
      if (!hit) continue;
      const compact: FotmobMatch[] = [];
      for (const m of league.matches || []) {
        if (m.status && m.status.finished === false) continue;
        const h = m.home?.score;
        const a = m.away?.score;
        if (h == null && a == null && !m.status?.scoreStr) continue;
        compact.push({
          id: m.id,
          home: m.home
            ? { id: m.home.id, name: m.home.name, score: m.home.score }
            : undefined,
          away: m.away
            ? { id: m.away.id, name: m.away.name, score: m.away.score }
            : undefined,
          status: {
            finished: m.status?.finished ?? true,
            utcTime: m.status?.utcTime,
            scoreStr: m.status?.scoreStr,
          },
        });
      }
      const part = indexFromFotmobMatches(compact);
      matchCount += compact.length;
      for (const [k, v] of part) {
        if (!index.has(k)) index.set(k, []);
        index.get(k)!.push(...v);
      }
    }
  }
  for (const [k, v] of index) index.set(k, dedupeSamples(v));
  const key = opts?.kvKey || `${EXT_PREFIX}fotmob:date-mixed`;
  if (index.size) {
    await kvPut(kv, key, JSON.stringify(indexToObject(index)), KV_TTL_LEAGUE);
  }
  return { ok: index.size > 0, teams: index.size, matches: matchCount, days };
}

const DATE_HINTS_BY_LEAGUE_ID: Record<number, DateLeagueHint[]> = {
  268: [{ ccode: "BRA", nameIncludes: ["série a", "serie a"], nameExcludes: ["série b", "serie b", "série c", "serie c"] }],
  8814: [{ ccode: "BRA", nameIncludes: ["série b", "serie b"] }],
  223: [{ ccode: "JPN", nameIncludes: ["j. league"], nameExcludes: ["j. league 2", "j. league 3"] }],
  130: [{ ccode: "USA", nameIncludes: ["mls", "major league"] }],
  161: [{ ccode: "URU", nameIncludes: ["liga auf", "uruguaya"] }],
};

/**
 * Build compact board-team form index for today/tomorrow HKJC slate.
 * /api/matches should only O(1)-merge this key (never parse large league dumps).
 */
export async function warmBoardTeamIndex(): Promise<{
  ok: boolean;
  boardTeams: number;
  teamsIndexed: number;
  leaguesWarmed: Array<{ id: number; label?: string; ok: boolean; skipped?: string; teams?: number }>;
  dateWarm?: { ok: boolean; teams: number; matches: number };
  unmappedCodes: string[];
}> {
  const env = await getEnv();
  const kv = env?.HISTORIC_CACHE;
  const now = new Date();
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);

  let rawMatches: Awaited<ReturnType<typeof fetchLiveFootballMatches>> = [];
  try {
    rawMatches = await fetchLiveFootballMatches([]);
  } catch {
    rawMatches = [];
  }

  const teamById = new Map<string, ExtTeamRef>();
  const demand = new Map<number, number>();
  const unmapped = new Set<string>();
  const codeCounts = new Map<string, number>();

  for (const raw of rawMatches) {
    if (!raw.kickOffTime) continue;
    const day = hktDateFromIso(raw.kickOffTime);
    if (day !== today && day !== tomorrow) continue;
    const league = raw.tournament?.name_en || "";
    const leagueCode = (raw.tournament?.code || "").toUpperCase();
    codeCounts.set(leagueCode, (codeCounts.get(leagueCode) || 0) + 1);
    const ids = resolveFotmobLeagueIds(leagueCode, league);
    if (!ids.length) {
      if (leagueCode) unmapped.add(leagueCode);
    }
    for (const id of ids) demand.set(id, (demand.get(id) || 0) + 1);
    for (const team of [raw.homeTeam, raw.awayTeam]) {
      if (!team?.id) continue;
      if (!teamById.has(team.id)) {
        teamById.set(team.id, {
          id: team.id,
          name: team.name_en || team.id,
          league,
          leagueCode,
        });
      }
    }
  }

  const leagueIds = [...demand.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 8);

  const leaguesWarmed: Array<{
    id: number;
    label?: string;
    ok: boolean;
    skipped?: string;
    teams?: number;
  }> = [];

  // Warm at most 5 league dumps per invocation (CPU); rest via date hints / prior KV
  const preferSmall = [9011, 51, 535, 9469, 11027, 161, 10342, 9091, 114, 9821, 251, 329];
  const forceIds: number[] = [];
  if ((codeCounts.get("QSL") || 0) > 0) forceIds.push(535);
  if ((codeCounts.get("UDC") || 0) > 0 || (codeCounts.get("UD1") || 0) > 0) forceIds.push(161);
  if ((codeCounts.get("ULP") || 0) > 0) forceIds.push(11027);
  if ((codeCounts.get("FVL") || 0) > 0) forceIds.push(51);
  const warmOrder = [
    ...forceIds,
    ...preferSmall.filter((id) => leagueIds.includes(id) && !forceIds.includes(id)),
    ...leagueIds.filter((id) => !preferSmall.includes(id) && !forceIds.includes(id)),
  ];
  for (const lid of [...new Set(warmOrder)].slice(0, 6)) {
    const label = WARM_FOTMOB_LEAGUES.find((x) => x.id === lid)?.label;
    const result = await warmFotmobLeague(lid);
    leaguesWarmed.push({
      id: lid,
      label,
      ok: result.ok,
      skipped: result.skipped,
      teams: result.teams,
    });
    if (!result.ok && result.skipped?.startsWith("too-large")) {
      const hints = DATE_HINTS_BY_LEAGUE_ID[lid];
      if (hints) {
        const dw = await warmFotmobByDateHints(hints, {
          days: 16,
          kvKey: `${EXT_PREFIX}fotmob:idx:${lid}`,
        });
        leaguesWarmed.push({
          id: lid,
          label: `${label || lid} (date)`,
          ok: dw.ok,
          teams: dw.teams,
        });
      }
    }
  }

  // Always top up Brazil/Japan club form via date window when those codes present
  const needDate: DateLeagueHint[] = [];
  if ((codeCounts.get("BD1") || 0) > 0) {
    needDate.push(...DATE_HINTS_BY_LEAGUE_ID[268]);
  }
  if ((codeCounts.get("BD2") || 0) > 0) {
    needDate.push(...DATE_HINTS_BY_LEAGUE_ID[8814]);
  }
  if ((codeCounts.get("JEC") || 0) > 0) {
    needDate.push({ ccode: "JPN", nameIncludes: ["j. league"] });
  }
  if ((codeCounts.get("FVL") || 0) > 0) {
    needDate.push({ ccode: "FIN", nameIncludes: ["veikkaus", "ykkos"] });
  }
  if ((codeCounts.get("QSL") || 0) > 0) {
    needDate.push({ ccode: "QAT", nameIncludes: ["stars", "qsl"] });
  }
  if ((codeCounts.get("ULP") || 0) > 0) {
    needDate.push({ ccode: "UAE", nameIncludes: ["league cup", "pro league", "arabian"] });
  }
  let dateWarm: { ok: boolean; teams: number; matches: number } | undefined;
  if (needDate.length) {
    dateWarm = await warmFotmobByDateHints(needDate, {
      days: 14,
      kvKey: `${EXT_PREFIX}fotmob:date-board`,
    });
  }

  // Merge indexes for demanded leagues + date-board into board-teams (names only)
  const merged: TeamIndex = new Map();
  const loadIds = [...new Set([...leagueIds, ...leaguesWarmed.map((x) => x.id)])];
  for (const lid of loadIds.slice(0, 8)) {
    const idx = await loadKvIndex(kv, `${EXT_PREFIX}fotmob:idx:${lid}`);
    for (const [k, v] of idx) {
      if (!merged.has(k)) merged.set(k, []);
      merged.get(k)!.push(...v);
    }
  }
  {
    const idx = await loadKvIndex(kv, `${EXT_PREFIX}fotmob:date-board`);
    for (const [k, v] of idx) {
      if (!merged.has(k)) merged.set(k, []);
      merged.get(k)!.push(...v);
    }
  }
  // Small always-useful indexes when already warm
  for (const lid of [114, 9821, 11027, 10342, 161, 9091, 9011, 51, 535, 9469, 329, 8814]) {
    if (merged.size > 400) break;
    const idx = await loadKvIndex(kv, `${EXT_PREFIX}fotmob:idx:${lid}`);
    for (const [k, v] of idx) {
      if (!merged.has(k)) merged.set(k, []);
      merged.get(k)!.push(...v);
    }
  }
  for (const [k, v] of merged) merged.set(k, dedupeSamples(v));

  const boardIndex: TeamIndex = new Map();
  for (const team of teamById.values()) {
    const samples = lookupInIndex(team.name, merged, team.league, {
      exactOnly: false,
    });
    if (!samples.length) continue;
    // Store under all HKJC alias keys so matches path is exact O(1)
    for (const k of getTeamAliasKeys(team.name)) {
      boardIndex.set(k, samples);
    }
  }

  await kvPut(
    kv,
    BOARD_TEAMS_KEY,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      today,
      tomorrow,
      teams: indexToObject(boardIndex),
      unmappedCodes: [...unmapped],
      codeCounts: Object.fromEntries(codeCounts),
    }),
    KV_TTL_BOARD_TEAMS
  );

  return {
    ok: boardIndex.size > 0 || teamById.size === 0,
    boardTeams: teamById.size,
    teamsIndexed: boardIndex.size,
    leaguesWarmed,
    dateWarm,
    unmappedCodes: [...unmapped],
  };
}

export async function enrichHistoricWithExternal(
  bundle: HistoricBundle,
  teams: ExtTeamRef[],
  opts?: { budgetMs?: number; maxLeagues?: number }
): Promise<{ bundle: HistoricBundle; stats: ExtEnrichStats }> {
  const maxLeaguesOpt = opts?.maxLeagues;
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

  const mergedIndex: TeamIndex = new Map();

  // Prefer pre-built board-teams index (O(1) exact lookups; warm writes this)
  const boardRaw = await kvGet(kv, BOARD_TEAMS_KEY);
  let usedBoardTeams = false;
  if (boardRaw) {
    try {
      const parsed = JSON.parse(boardRaw) as {
        teams?: Record<string, ExtSample[]>;
      };
      if (parsed.teams && typeof parsed.teams === "object") {
        for (const [k, v] of Object.entries(parsed.teams)) {
          mergedIndex.set(k, v || []);
        }
        usedBoardTeams = mergedIndex.size > 0;
        if (usedBoardTeams) {
          stats.fotmobLeagues = 1;
          sourcesUsed.add("fotmob");
        }
      }
    } catch {
      // fall through to tiny league fallback
    }
  }

  // Fallback: at most 1 small league index + exact-only (never CSV/openliga on hot path)
  if (!usedBoardTeams) {
    const demand = new Map<number, number>();
    for (const { team } of thin) {
      for (const id of resolveFotmobLeagueIds(team.leagueCode, team.league)) {
        demand.set(id, (demand.get(id) || 0) + 1);
      }
    }
    const preferred = [
      9011, 51, 535, 9469, 11027, 10342, 9091, 9821, 114, 329, 251, 288,
    ];
    const leagueIds = [...demand.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const ordered = [
      ...preferred.filter((id) => leagueIds.includes(id)),
      ...leagueIds.filter((id) => !preferred.includes(id)),
      ...preferred.filter((id) => !leagueIds.includes(id)),
    ];
    const maxLeagues = Math.max(0, maxLeaguesOpt ?? 1);
    let loaded = 0;
    for (const lid of ordered) {
      if (loaded >= maxLeagues) break;
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
    for (const [k, v] of mergedIndex) mergedIndex.set(k, dedupeSamples(v));
  }

  for (const { team, n } of thin) {
    const extra = lookupInIndex(team.name, mergedIndex, team.league, {
      exactOnly: true,
    });
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
      ? ` · ext[${usedBoardTeams ? "board-teams+" : ""}${stats.sourcesUsed.join("+")}] +${stats.teamsEnriched}`
      : stats.teamsEnriched > 0
        ? ` · ext[+${stats.teamsEnriched}]`
        : " · ext[kv-miss: run /api/warm-ext?source=board]";
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
