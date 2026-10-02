import { NextResponse } from "next/server";
import {
  cacheControlForBoard,
  serveCachedBoard,
} from "@/lib/board-cache";
import { fetchMatchesPayload } from "@/lib/hkjc";
import {
  overlayLockedPredictions,
  sideEffectRecordAndSettleBackground,
} from "@/lib/prediction-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Fast board payload for Free Workers (KV-first).
 *
 * - default: serve `board:v1:today-tomorrow` from KV (TTL ~3h)
 *   then merge a cheap live GraphQL overlay for score/minute/status.
 * - ?light=1: cache hit → full board; miss → fixtures only (never 1102).
 * - ?refresh=1 / ?nocache=1: bypass KV, rebuild, rewrite.
 *
 * Heavy form deepen: /api/warm-ext (cron). Prediction settle: background.
 * Avoid Worker 1102 — never rebuild historic/extform on the hot path when cached.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const light =
    url.searchParams.get("light") === "1" ||
    url.searchParams.get("light") === "true";
  const bypass =
    url.searchParams.get("refresh") === "1" ||
    url.searchParams.get("nocache") === "1" ||
    url.searchParams.get("refresh") === "true" ||
    url.searchParams.get("nocache") === "true";

  const { payload, meta } = await serveCachedBoard(
    { light, bypass, liveOverlay: true },
    async () => {
      const built = await fetchMatchesPayload({ light, form: !light });
      if (!light && built.source === "live" && built.matches.length > 0) {
        try {
          await overlayLockedPredictions(built.matches);
        } catch {
          // ignore
        }
      }
      return built;
    }
  );

  if (!light && payload.source === "live" && payload.matches.length > 0) {
    sideEffectRecordAndSettleBackground(payload.matches);
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": cacheControlForBoard(payload.matches, meta.cache),
      "X-Board-Cache": meta.cache,
      "X-Board-Cache-Key": meta.key,
      "X-Board-Cache-TTL": meta.ttlSec != null ? String(meta.ttlSec) : "",
      "X-Board-Cache-Age": meta.ageSec != null ? String(meta.ageSec) : "",
      "X-Board-Live-Overlay": meta.liveOverlay ? "1" : "0",
    },
  });
}
