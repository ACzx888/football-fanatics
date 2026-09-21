import { NextResponse } from "next/server";
import { fetchMatchesPayload } from "@/lib/hkjc";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await fetchMatchesPayload();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
