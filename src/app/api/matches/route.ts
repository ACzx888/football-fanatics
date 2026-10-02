import { NextResponse } from "next/server";
import { fetchMatchesPayload } from "@/lib/hkjc";
import {
  overlayLockedPredictions,
  sideEffectRecordAndSettleBackground,
} from "@/lib/prediction-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Fast board payload for Free Workers.
 * - default: live + tiny memory/KV form (no HKJC historic network)
 * - ?light=1: live fixtures only (no form / overlay) — never 1102
 * Heavy form deepen: /api/warm-ext (cron). Prediction settle: background.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const light =
    url.searchParams.get("light") === "1" ||
    url.searchParams.get("light") === "true";

  const payload = await fetchMatchesPayload({ light, form: !light });

  if (!light && payload.source === "live" && payload.matches.length > 0) {
    try {
      // Cap overlay work: forecast lock when KV snapshots exist
      await overlayLockedPredictions(payload.matches);
    } catch {
      // ignore
    }
    sideEffectRecordAndSettleBackground(payload.matches);
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
