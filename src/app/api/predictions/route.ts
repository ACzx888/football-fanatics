import { NextResponse } from "next/server";
import { getPredictionsPayload } from "@/lib/prediction-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await getPredictionsPayload();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
