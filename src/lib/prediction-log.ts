import { getCloudflareContext } from "@opennextjs/cloudflare";
import { pickFullTimeResult } from "./historic";
import {
  searchHistoricFootballMatches,
} from "./hkjc-graphql";
import { addDaysHkt, formatHktDate, hktDateFromIso } from "./time";
import type { FootballMatch, MatchPredictions } from "./types";

/** Settled once kickoff is this old, or status already ended. */
const SETTLE_AFTER_MS = 2.5 * 60 * 60 * 1000;
const INDEX_KEY = "pred-index";
const KEY_PREFIX = "pred:";
const MAX_INDEX = 400;
const SETTLE_BATCH = 8;
/** Corner expected vs actual absolute tolerance for "close enough". */
const CORNER_TOLERANCE = 1.5;

export type HadPickCode = "H" | "D" | "A" | string;

export interface StoredHadPrediction {
  available: boolean;
  pick: string | null;
  pickCode: HadPickCode | null;
  confidencePct: number | null;
  modelProb: number | null;
  selections: Array<{ code: string; label: string; modelPct: number }>;
  detail?: string;
}

export interface StoredCornerPrediction {
  available: boolean;
  expected: number | null;
  confidencePct: number | null;
  label?: string;
}

export interface PredictionRecord {
  /** KV key without needing to recompute: pred:{matchId}:{predictionDay} */
  key: string;
  matchId: string;
  frontEndId: string;
  kickOffTime: string;
  predictionDay: string;
  league: string;
  leagueCode: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId?: string;
  awayTeamId?: string;
  statusAtRecord: string;
  recordedAt: string;
  updatedAt: string;
  had: StoredHadPrediction;
  totalCorners: StoredCornerPrediction;
  homeCorners: StoredCornerPrediction;
  awayCorners: StoredCornerPrediction;
  /** Result fields — null until settled */
  homeScore: number | null;
  awayScore: number | null;
  corners: number | null;
  homeCorner: number | null;
  awayCorner: number | null;
  settledAt: string | null;
  hadActual: HadPickCode | null;
  hadCorrect: boolean | null;
  /** true when |expected - actual| <= tolerance; null if missing data */
  cornersClose: boolean | null;
  settleStatus: "pending" | "settled" | "void";
}

export interface PredictionSummary {
  total: number;
  pending: number;
  settled: number;
  voided: number;
  hadSettled: number;
  hadCorrect: number;
  hadAccuracyPct: number | null;
  avgConfidenceCorrect: number | null;
  avgConfidenceWrong: number | null;
  byLeague: Array<{
    league: string;
    settled: number;
    correct: number;
    accuracyPct: number | null;
  }>;
  cornersCompared: number;
  cornersClose: number;
}

export interface PredictionsApiResponse {
  ok: boolean;
  timezone: string;
  fetchedAt: string;
  settledThisCall: number;
  summary: PredictionSummary;
  records: PredictionRecord[];
  error?: string | null;
}

type FfKv = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

function hadCodeFromLabel(label: string | undefined): HadPickCode | null {
  if (!label) return null;
  const l = label.trim().toLowerCase();
  if (l === "home" || l === "h") return "H";
  if (l === "draw" || l === "d" || l === "x") return "D";
  if (l === "away" || l === "a") return "A";
  return null;
}

function hadCodeFromScore(
  home: number,
  away: number
): HadPickCode {
  if (home > away) return "H";
  if (home < away) return "A";
  return "D";
}

function cornerStored(
  p: MatchPredictions["totalCorners"]
): StoredCornerPrediction {
  return {
    available: !!p.available,
    expected: p.available ? p.expectedValue ?? null : null,
    confidencePct: p.available ? p.confidencePct ?? null : null,
    label: p.label,
  };
}

export function predictionKey(matchId: string, predictionDay: string): string {
  return `${KEY_PREFIX}${matchId}:${predictionDay}`;
}

async function getKv(): Promise<FfKv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as { HISTORIC_CACHE?: FfKv } | undefined;
    return env?.HISTORIC_CACHE ?? null;
  } catch {
    return null;
  }
}

async function readIndex(kv: FfKv): Promise<string[]> {
  try {
    const raw = await kv.get(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(kv: FfKv, keys: string[]): Promise<void> {
  const unique = [...new Set(keys)].slice(-MAX_INDEX);
  await kv.put(INDEX_KEY, JSON.stringify(unique));
}

function fromMatch(
  m: FootballMatch,
  predictionDay: string,
  existing?: PredictionRecord | null
): PredictionRecord {
  const key = predictionKey(m.id, predictionDay);
  const nowIso = new Date().toISOString();
  const hadAvail = !!m.predictions.had.available;
  const pickLabel = hadAvail ? m.predictions.had.label ?? null : null;
  const pickCode = hadCodeFromLabel(pickLabel ?? undefined);

  const base: PredictionRecord = {
    key,
    matchId: m.id,
    frontEndId: m.frontEndId,
    kickOffTime: m.kickOffTime,
    predictionDay,
    league: m.league,
    leagueCode: m.leagueCode,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    statusAtRecord: String(m.status),
    recordedAt: existing?.recordedAt ?? nowIso,
    updatedAt: nowIso,
    had: {
      available: hadAvail,
      pick: pickLabel,
      pickCode,
      confidencePct: hadAvail ? m.predictions.had.confidencePct ?? null : null,
      modelProb: hadAvail ? m.predictions.had.modelProb ?? null : null,
      selections: (m.predictions.had.selections || []).map((s) => ({
        code: s.code,
        label: s.label,
        modelPct: s.modelPct,
      })),
      detail: m.predictions.had.detail,
    },
    totalCorners: cornerStored(m.predictions.totalCorners),
    homeCorners: cornerStored(m.predictions.homeCorners),
    awayCorners: cornerStored(m.predictions.awayCorners),
    homeScore: existing?.homeScore ?? null,
    awayScore: existing?.awayScore ?? null,
    corners: existing?.corners ?? null,
    homeCorner: existing?.homeCorner ?? null,
    awayCorner: existing?.awayCorner ?? null,
    settledAt: existing?.settledAt ?? null,
    hadActual: existing?.hadActual ?? null,
    hadCorrect: existing?.hadCorrect ?? null,
    cornersClose: existing?.cornersClose ?? null,
    settleStatus: existing?.settleStatus ?? "pending",
  };
  return base;
}

/**
 * Upsert prediction records for live matches (skip if HAD unavailable and no
 * corner projection — still store when any prediction is available).
 * Idempotent by matchId + predictionDay (HKT kickoff date).
 */
export async function recordLivePredictions(
  matches: FootballMatch[]
): Promise<number> {
  const kv = await getKv();
  if (!kv) return 0;

  let written = 0;
  const index = await readIndex(kv);
  const indexSet = new Set(index);

  for (const m of matches) {
    try {
      const hasHad = m.predictions.had.available;
      const hasCorner =
        m.predictions.totalCorners.available ||
        m.predictions.homeCorners.available ||
        m.predictions.awayCorners.available;
      if (!hasHad && !hasCorner) continue;

      const predictionDay = m.matchDate || hktDateFromIso(m.kickOffTime);
      const key = predictionKey(m.id, predictionDay);
      let existing: PredictionRecord | null = null;
      try {
        const raw = await kv.get(key);
        if (raw) existing = JSON.parse(raw) as PredictionRecord;
      } catch {
        existing = null;
      }

      // Do not overwrite settled result fields; refresh prediction if still pending
      const next = fromMatch(m, predictionDay, existing);
      if (existing?.settleStatus === "settled") {
        // Keep result; optionally refresh prediction snapshot only if never settled
        next.homeScore = existing.homeScore;
        next.awayScore = existing.awayScore;
        next.corners = existing.corners;
        next.homeCorner = existing.homeCorner;
        next.awayCorner = existing.awayCorner;
        next.settledAt = existing.settledAt;
        next.hadActual = existing.hadActual;
        next.hadCorrect = existing.hadCorrect;
        next.cornersClose = existing.cornersClose;
        next.settleStatus = "settled";
        // Keep original HAD pick once settled (don't rewrite history)
        next.had = existing.had;
        next.totalCorners = existing.totalCorners;
        next.homeCorners = existing.homeCorners;
        next.awayCorners = existing.awayCorners;
        next.recordedAt = existing.recordedAt;
      }

      await kv.put(key, JSON.stringify(next));
      if (!indexSet.has(key)) {
        indexSet.add(key);
        index.push(key);
      }
      written++;
    } catch {
      // ignore per-match write failures
    }
  }

  try {
    await writeIndex(kv, index);
  } catch {
    // ignore index write failure
  }
  return written;
}

function applyResult(
  rec: PredictionRecord,
  scores: {
    home: number;
    away: number;
    corners: number | null;
    homeCorner?: number | null;
    awayCorner?: number | null;
  }
): PredictionRecord {
  const hadActual = hadCodeFromScore(scores.home, scores.away);
  let hadCorrect: boolean | null = null;
  if (rec.had.available && rec.had.pickCode) {
    hadCorrect = rec.had.pickCode === hadActual;
  }

  let cornersClose: boolean | null = null;
  if (
    rec.totalCorners.available &&
    rec.totalCorners.expected != null &&
    scores.corners != null
  ) {
    cornersClose =
      Math.abs(rec.totalCorners.expected - scores.corners) <= CORNER_TOLERANCE;
  }

  return {
    ...rec,
    homeScore: scores.home,
    awayScore: scores.away,
    corners: scores.corners,
    homeCorner: scores.homeCorner ?? rec.homeCorner,
    awayCorner: scores.awayCorner ?? rec.awayCorner,
    settledAt: new Date().toISOString(),
    hadActual,
    hadCorrect,
    cornersClose,
    settleStatus: "settled",
    updatedAt: new Date().toISOString(),
  };
}

function isEndedStatus(status: string): boolean {
  const s = status.toUpperCase();
  return ["FULLTIME", "ENDED", "FT", "COMPLETED", "RESULT"].includes(s);
}

function needsSettlement(rec: PredictionRecord, now = Date.now()): boolean {
  if (rec.settleStatus === "settled" || rec.settleStatus === "void") return false;
  if (isEndedStatus(rec.statusAtRecord)) return true;
  const kick = new Date(rec.kickOffTime).getTime();
  if (Number.isNaN(kick)) return false;
  return now - kick >= SETTLE_AFTER_MS;
}

/** Apply scores from live match payload when FT is already known. */
export async function settleFromLiveMatches(
  matches: FootballMatch[]
): Promise<number> {
  const kv = await getKv();
  if (!kv) return 0;
  let n = 0;
  for (const m of matches) {
    if (!isEndedStatus(String(m.status))) continue;
    if (
      m.live?.homeScore == null ||
      m.live?.awayScore == null
    ) {
      continue;
    }
    const predictionDay = m.matchDate || hktDateFromIso(m.kickOffTime);
    const key = predictionKey(m.id, predictionDay);
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const rec = JSON.parse(raw) as PredictionRecord;
      if (rec.settleStatus === "settled") continue;
      const next = applyResult(rec, {
        home: m.live.homeScore,
        away: m.live.awayScore,
        corners: m.live.corner ?? null,
        homeCorner: m.live.homeCorner ?? null,
        awayCorner: m.live.awayCorner ?? null,
      });
      await kv.put(key, JSON.stringify(next));
      n++;
    } catch {
      // ignore
    }
  }
  return n;
}

async function fetchHistoricResultForMatch(
  rec: PredictionRecord
): Promise<{
  home: number;
  away: number;
  corners: number | null;
} | null> {
  const teamId = rec.homeTeamId || rec.awayTeamId;
  if (!teamId) return null;

  const kickDay = hktDateFromIso(rec.kickOffTime);
  const kickDate = new Date(rec.kickOffTime);
  const startDate = addDaysHkt(kickDate, -1);
  const endDate = addDaysHkt(kickDate, 1);

  try {
    const attempts: Array<{ startDate: string; endDate: string }> = [
      { startDate, endDate },
      { startDate: kickDay, endDate: kickDay },
    ];
    for (const range of attempts) {
      const r = await searchHistoricFootballMatches(
        {
          startDate: range.startDate,
          endDate: range.endDate,
          startIndex: 0,
          endIndex: 40,
          teamId,
        },
        { timeoutMs: 6_000 }
      );
      const found = (r.matches || []).find((m) => String(m.id) === rec.matchId);
      if (found) return pickFullTimeResult(found.results);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Settle a batch of unsettled records whose kickoff is old enough / ended.
 * Returns number newly settled.
 */
export async function settlePendingPredictions(
  opts?: { limit?: number }
): Promise<number> {
  const kv = await getKv();
  if (!kv) return 0;
  const limit = opts?.limit ?? SETTLE_BATCH;
  const keys = await readIndex(kv);
  const now = Date.now();
  let settled = 0;

  for (const key of keys) {
    if (settled >= limit) break;
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const rec = JSON.parse(raw) as PredictionRecord;
      if (!needsSettlement(rec, now)) continue;

      const result = await fetchHistoricResultForMatch(rec);
      if (!result) continue;

      const next = applyResult(rec, {
        home: result.home,
        away: result.away,
        corners: result.corners,
      });
      await kv.put(key, JSON.stringify(next));
      settled++;
    } catch {
      // ignore
    }
  }
  return settled;
}

export function computeSummary(records: PredictionRecord[]): PredictionSummary {
  const settled = records.filter((r) => r.settleStatus === "settled");
  const pending = records.filter((r) => r.settleStatus === "pending");
  const voided = records.filter((r) => r.settleStatus === "void");

  const hadSettled = settled.filter(
    (r) => r.had.available && r.hadCorrect != null
  );
  const hadCorrect = hadSettled.filter((r) => r.hadCorrect === true);
  const hadWrong = hadSettled.filter((r) => r.hadCorrect === false);

  const avg = (vals: number[]) =>
    vals.length
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : null;

  const byLeagueMap = new Map<string, { settled: number; correct: number }>();
  for (const r of hadSettled) {
    const league = r.league || "Unknown";
    const cur = byLeagueMap.get(league) || { settled: 0, correct: 0 };
    cur.settled++;
    if (r.hadCorrect) cur.correct++;
    byLeagueMap.set(league, cur);
  }
  const byLeague = [...byLeagueMap.entries()]
    .map(([league, v]) => ({
      league,
      settled: v.settled,
      correct: v.correct,
      accuracyPct:
        v.settled > 0
          ? Math.round((v.correct / v.settled) * 1000) / 10
          : null,
    }))
    .sort((a, b) => b.settled - a.settled);

  const cornersCompared = settled.filter((r) => r.cornersClose != null);
  const cornersClose = cornersCompared.filter((r) => r.cornersClose === true);

  return {
    total: records.length,
    pending: pending.length,
    settled: settled.length,
    voided: voided.length,
    hadSettled: hadSettled.length,
    hadCorrect: hadCorrect.length,
    hadAccuracyPct:
      hadSettled.length > 0
        ? Math.round((hadCorrect.length / hadSettled.length) * 1000) / 10
        : null,
    avgConfidenceCorrect: avg(
      hadCorrect
        .map((r) => r.had.confidencePct)
        .filter((c): c is number => c != null)
    ),
    avgConfidenceWrong: avg(
      hadWrong
        .map((r) => r.had.confidencePct)
        .filter((c): c is number => c != null)
    ),
    byLeague,
    cornersCompared: cornersCompared.length,
    cornersClose: cornersClose.length,
  };
}

export async function listPredictionRecords(): Promise<PredictionRecord[]> {
  const kv = await getKv();
  if (!kv) return [];
  const keys = await readIndex(kv);
  const records: PredictionRecord[] = [];
  for (const key of keys) {
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const rec = JSON.parse(raw) as PredictionRecord;
      if (rec?.matchId) records.push(rec);
    } catch {
      // skip bad row
    }
  }
  records.sort(
    (a, b) =>
      new Date(b.kickOffTime).getTime() - new Date(a.kickOffTime).getTime()
  );
  return records;
}

export async function getPredictionsPayload(): Promise<PredictionsApiResponse> {
  const fetchedAt = new Date().toISOString();
  let settledThisCall = 0;
  let error: string | null = null;
  try {
    settledThisCall = await settlePendingPredictions({ limit: SETTLE_BATCH });
  } catch (e) {
    error = e instanceof Error ? e.message : "Settlement failed";
  }

  let records: PredictionRecord[] = [];
  try {
    records = await listPredictionRecords();
  } catch (e) {
    error =
      (error ? error + "; " : "") +
      (e instanceof Error ? e.message : "List failed");
  }

  return {
    ok: !error,
    timezone: "Asia/Hong_Kong",
    fetchedAt,
    settledThisCall,
    summary: computeSummary(records),
    records,
    error,
  };
}

/** Used by matches API — ignore failures. */
export async function sideEffectRecordAndSettle(
  matches: FootballMatch[]
): Promise<void> {
  try {
    await recordLivePredictions(matches);
  } catch {
    // never fail matches
  }
  try {
    await settleFromLiveMatches(matches);
  } catch {
    // ignore
  }
}

export function formatHktTodayForLog(): string {
  return formatHktDate(new Date());
}
