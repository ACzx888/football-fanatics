import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function probe(
  url: string
): Promise<{ ok: boolean; status?: number; bytes?: number; err?: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "FootballFanatics/1.0",
        Accept: "application/json,text/csv,*/*",
      },
      signal: AbortSignal.timeout(8000),
    });
    const buf = await res.arrayBuffer();
    return { ok: res.ok, status: res.status, bytes: buf.byteLength };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const targets: Record<string, string> = {
    thesportsdb:
      "https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Belize",
    fotmob_small: "https://www.fotmob.com/api/data/leagues?id=329",
    fotmob_cnl: "https://www.fotmob.com/api/data/leagues?id=9821",
    openliga: "https://api.openligadb.de/getmatchdata/bl1",
    fdcsv: "https://www.football-data.co.uk/mmz4281/2526/E0.csv",
  };
  const out: Record<string, unknown> = {};
  for (const [k, url] of Object.entries(targets)) {
    out[k] = await probe(url);
  }
  return NextResponse.json({ ok: true, probes: out });
}
