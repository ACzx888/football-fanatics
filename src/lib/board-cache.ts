/**
 * KV-first board cache for fixtures + locked pre-match predictions.
 *
 * Pre-event board: long TTL (~3h) — avoid rebuild / 1102 on every page load.
 * In-play scores/minutes: merged from a cheap live GraphQL overlay (short client refresh).
 * Heavy form deepen stays on /api/warm-ext (cron), not /api/matches.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fetchLiveFootballMatches, type RawLiveMatch } from "./hkjc-graphql";
import { buildPredictions } from "./predictions";
import {
  addDaysHkt,
  estimateMinuteLabel,
  formatHktDate,
  hktDateFromIso,
  isInPlayStatus,
} from "./time";
import type { FootballMatch, MatchesApiResponse } from "./types";

export const BOARD_CACHE_KEY = "board:v1:today-tomorrow";
/** Pre-event fixtures + predictions — hours, not per page load. */
export const BOARD_TTL_PRE_EVENT_SEC = 3 * 60 * 60; // 3h
/** HTTP hint when serving a cache hit with no in-play. */
export const HTTP_MAX_AGE_PRE_EVENT = 300; // 5 min CDN/browser
/** HTTP hint when in-play (live overlay already applied). */
export const HTTP_MAX_AGE_INPLAY = 30;

type FfKv = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type BoardCacheMeta = {
  cache: "HIT" | "MISS" | "BYPASS" | "LIGHT";
  ttlSec: number | null;
  ageSec: number | null;
  liveOverlay: boolean;
  key: string;
};

async function getKv(): Promise<FfKv | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as { HISTORIC_CACHE?: FfKv } | undefined;
    return env?.HISTORIC_CACHE ?? null;
  } catch {
    return null;
  }
}

function boardHasInPlay(matches: FootballMatch[]): boolean {
  return matches.some((m) => m.isInPlay);
}

export function cacheControlForBoard(
  matches: FootballMatch[],
  cache: BoardCacheMeta["cache"]
): string {
  if (cache === "BYPASS" || cache === "LIGHT") {
    return "no-store, max-age=0";
  }
  const maxAge = boardHasInPlay(matches)
    ? HTTP_MAX_AGE_INPLAY
    : HTTP_MAX_AGE_PRE_EVENT;
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`;
}

export async function readBoardCache(): Promise<{
  payload: MatchesApiResponse;
  ageSec: number;
} | null> {
  const kv = await getKv();
  if (!kv) return null;
  try {
    const raw = await kv.get(BOARD_CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as MatchesApiResponse & {
      _cachedAt?: string;
    };
    if (!payload?.matches || !Array.isArray(payload.matches)) return null;

    const today = formatHktDate(new Date());
    const tomorrow = addDaysHkt(new Date(), 1);
    if (payload.today !== today || payload.tomorrow !== tomorrow) {
      // Calendar rolled — treat as miss
      return null;
    }

    const cachedAt = payload._cachedAt
      ? Date.parse(payload._cachedAt)
      : payload.fetchedAt
        ? Date.parse(payload.fetchedAt)
        : NaN;
    const ageSec = Number.isFinite(cachedAt)
      ? Math.max(0, Math.floor((Date.now() - cachedAt) / 1000))
      : 0;

    // Strip internal field before serving
    delete (payload as { _cachedAt?: string })._cachedAt;
    return { payload, ageSec };
  } catch {
    return null;
  }
}

export async function writeBoardCache(
  payload: MatchesApiResponse
): Promise<{ ttlSec: number } | null> {
  const kv = await getKv();
  if (!kv) return null;
  if (payload.source !== "live" || payload.matches.length === 0) return null;

  const ttlSec = BOARD_TTL_PRE_EVENT_SEC;
  const toStore = {
    ...payload,
    _cachedAt: new Date().toISOString(),
  };
  try {
    await kv.put(BOARD_CACHE_KEY, JSON.stringify(toStore), {
      expirationTtl: Math.max(60, ttlSec),
    });
    return { ttlSec };
  } catch {
    return null;
  }
}

/** Drop board cache after warm-ext so next board rebuild picks up new form. */
export async function invalidateBoardCache(): Promise<boolean> {
  const kv = await getKv();
  if (!kv?.delete) return false;
  try {
    await kv.delete(BOARD_CACHE_KEY);
    return true;
  } catch {
    return false;
  }
}

function liveFromRaw(raw: RawLiveMatch): FootballMatch["live"] {
  const rr = raw.runningResult;
  if (
    !rr ||
    (rr.homeScore == null &&
      rr.awayScore == null &&
      rr.corner == null &&
      rr.homeCorner == null &&
      rr.awayCorner == null)
  ) {
    return null;
  }
  return {
    homeScore: rr.homeScore ?? null,
    awayScore: rr.awayScore ?? null,
    corner: rr.corner ?? null,
    homeCorner: rr.homeCorner ?? null,
    awayCorner: rr.awayCorner ?? null,
  };
}

function insufficientPredictions() {
  return buildPredictions({
    homeForm: null,
    awayForm: null,
    leagueAvgGoals: 1.3,
    historicOk: false,
    formSources: [],
  });
}

/**
 * Merge cheap live GraphQL fields onto a cached board (keep locked predictions).
 * New fixtures get Insufficient Data until the next full board rebuild.
 */
export async function mergeLiveOverlay(
  cached: MatchesApiResponse
): Promise<{ payload: MatchesApiResponse; overlayed: boolean }> {
  const now = new Date();
  const today = formatHktDate(now);
  const tomorrow = addDaysHkt(now, 1);

  let rawMatches: RawLiveMatch[] = [];
  try {
    rawMatches = await fetchLiveFootballMatches([]);
  } catch {
    return { payload: cached, overlayed: false };
  }

  const byId = new Map(cached.matches.map((m) => [m.id, m]));
  const merged: FootballMatch[] = [];
  const seen = new Set<string>();

  for (const raw of rawMatches) {
    if (!raw.id || !raw.kickOffTime) continue;
    const day = hktDateFromIso(raw.kickOffTime);
    if (day !== today && day !== tomorrow) continue;

    const id = String(raw.id);
    seen.add(id);
    const status = raw.status || "UNKNOWN";
    const isInPlay = isInPlayStatus(status);
    const minuteLabel = estimateMinuteLabel(raw.kickOffTime, status, now);
    const live = liveFromRaw(raw);
    const existing = byId.get(id);

    if (existing) {
      merged.push({
        ...existing,
        status,
        isInPlay,
        minuteLabel,
        live,
        kickOffTime: raw.kickOffTime || existing.kickOffTime,
        matchDate: day,
        dayBucket: day === today ? "today" : "tomorrow",
        frontEndId: raw.frontEndId || existing.frontEndId,
        league: raw.tournament?.name_en || existing.league,
        leagueCode: raw.tournament?.code || existing.leagueCode,
        homeTeam: raw.homeTeam?.name_en || existing.homeTeam,
        awayTeam: raw.awayTeam?.name_en || existing.awayTeam,
        // Keep existing.predictions (locked / cached)
      });
    } else {
      // New fixture since cache write — show without form until rebuild
      merged.push({
        id,
        frontEndId: raw.frontEndId || id,
        kickOffTime: raw.kickOffTime,
        matchDate: day,
        status,
        league: raw.tournament?.name_en || "Unknown League",
        leagueCode: raw.tournament?.code || "",
        homeTeam: raw.homeTeam?.name_en || "Home",
        awayTeam: raw.awayTeam?.name_en || "Away",
        homeTeamCh: raw.homeTeam?.name_ch,
        awayTeamCh: raw.awayTeam?.name_ch,
        homeTeamId: raw.homeTeam?.id,
        awayTeamId: raw.awayTeam?.id,
        isInPlay,
        minuteLabel,
        live,
        predictions: insufficientPredictions(),
        dayBucket: day === today ? "today" : "tomorrow",
      });
    }
  }

  // Keep cached matches that disappeared from live only if still today/tomorrow
  // (avoid flicker); drop if day rolled for that row
  for (const m of cached.matches) {
    if (seen.has(m.id)) continue;
    if (m.matchDate !== today && m.matchDate !== tomorrow) continue;
    merged.push(m);
  }

  merged.sort(
    (a, b) =>
      new Date(a.kickOffTime).getTime() - new Date(b.kickOffTime).getTime()
  );

  const payload: MatchesApiResponse = {
    ...cached,
    ok: true,
    source: "live",
    error: null,
    today,
    tomorrow,
    fetchedAt: now.toISOString(),
    matchCount: merged.length,
    matches: merged,
    filteredCount: merged.length,
    rawMatchCount: rawMatches.length,
  };

  return { payload, overlayed: true };
}

export type ServeBoardOptions = {
  /** Skip KV read and rebuild. */
  bypass?: boolean;
  /**
   * Light path: on cache miss, do not run form merge (fixtures only).
   * On cache hit, still serve full cached board (predictions included).
   */
  light?: boolean;
  /** Apply live GraphQL overlay on cache hit (default true unless light miss). */
  liveOverlay?: boolean;
};

/**
 * KV-first board serve. Caller supplies `buildFull` for cache miss (form + overlay locks).
 */
export async function serveCachedBoard(
  opts: ServeBoardOptions,
  buildFull: () => Promise<MatchesApiResponse>
): Promise<{ payload: MatchesApiResponse; meta: BoardCacheMeta }> {
  const bypass = opts.bypass === true;
  const light = opts.light === true;
  const wantOverlay = opts.liveOverlay !== false;

  if (!bypass) {
    const hit = await readBoardCache();
    if (hit) {
      let payload = hit.payload;
      let liveOverlay = false;
      if (wantOverlay) {
        const merged = await mergeLiveOverlay(payload);
        payload = merged.payload;
        liveOverlay = merged.overlayed;
      }
      return {
        payload,
        meta: {
          cache: "HIT",
          ttlSec: BOARD_TTL_PRE_EVENT_SEC,
          ageSec: hit.ageSec,
          liveOverlay,
          key: BOARD_CACHE_KEY,
        },
      };
    }
  }

  // Miss / bypass
  if (light && !bypass) {
    // Light miss: fixtures only — do not populate long board cache (incomplete form)
    const payload = await buildFull();
    return {
      payload,
      meta: {
        cache: "LIGHT",
        ttlSec: null,
        ageSec: null,
        liveOverlay: false,
        key: BOARD_CACHE_KEY,
      },
    };
  }

  const payload = await buildFull();
  const written = await writeBoardCache(payload);
  return {
    payload,
    meta: {
      cache: bypass ? "BYPASS" : "MISS",
      ttlSec: written?.ttlSec ?? null,
      ageSec: 0,
      liveOverlay: false,
      key: BOARD_CACHE_KEY,
    },
  };
}
