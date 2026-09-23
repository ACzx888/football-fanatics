import { NextResponse } from "next/server";
import { fetchMatchesPayload } from "@/lib/hkjc";
import { sideEffectRecordAndSettle } from "@/lib/prediction-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await fetchMatchesPayload();

  // Persist predictions as a non-blocking side effect (live only; never fail matches)
  if (payload.source === "live" && payload.matches.length > 0) {
    try {
      // Await briefly so Workers don't kill the async task immediately;
      // still swallow all errors so /api/matches stays resilient.
      await sideEffectRecordAndSettle(payload.matches);
    } catch {
      // ignore KV / settlement failures
    }
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
