import { NextResponse } from "next/server";
import { fetchMatchesPayload } from "@/lib/hkjc";
import {
  overlayLockedPredictions,
  sideEffectRecordAndSettleBackground,
} from "@/lib/prediction-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Fast board payload. Historic + ext form are memory/KV-first with a tiny
 * network fill. Prediction record/settle is fire-and-forget so we never 1102.
 * Optional: ?light=1 skips HKJC historic network entirely.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const light =
    url.searchParams.get("light") === "1" ||
    url.searchParams.get("light") === "true";

  const payload = await fetchMatchesPayload({ light });

  // Forecast lock overlay (KV reads only) — keep on the critical path so the
  // board shows locked numbers. Cap failures so matches always return.
  if (payload.source === "live" && payload.matches.length > 0) {
    try {
      await overlayLockedPredictions(payload.matches);
    } catch {
      // ignore
    }
    // Record + settle off the critical path (waitUntil when available)
    sideEffectRecordAndSettleBackground(payload.matches);
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
