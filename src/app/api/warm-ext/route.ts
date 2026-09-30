import { NextResponse } from "next/server";
import {
  warmFdCsvDiv,
  warmFotmobLeague,
  warmOpenLiga,
  WARM_FOTMOB_LEAGUES,
} from "@/lib/ext-form";

export const dynamic = "force-dynamic";

/**
 * Warm external form indexes into HISTORIC_CACHE (one step per call).
 * Query:
 *   ?source=fotmob&id=9821
 *   ?source=fotmob&next=1     (next unwarmed from allow-list — client loops)
 *   ?source=csv&div=E0
 *   ?source=openliga
 *   ?source=all-small         (warm up to 3 small fotmob + E0 csv this call)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "all-small";

  try {
    if (source === "fotmob") {
      const idParam = url.searchParams.get("id");
      const id = idParam ? Number(idParam) : WARM_FOTMOB_LEAGUES[0]?.id;
      if (!id || !Number.isFinite(id)) {
        return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
      }
      const result = await warmFotmobLeague(id);
      const label =
        WARM_FOTMOB_LEAGUES.find((x) => x.id === id)?.label || String(id);
      return NextResponse.json({ ok: result.ok, source: "fotmob", id, label, result });
    }

    if (source === "csv") {
      const div = url.searchParams.get("div") || "E0";
      const result = await warmFdCsvDiv(div);
      return NextResponse.json({ ok: result.ok, source: "csv", div, result });
    }

    if (source === "openliga") {
      const result = await warmOpenLiga();
      return NextResponse.json({ ok: result.ok, source: "openliga", result });
    }

    if (source === "all-small") {
      // Warm a few small leagues + one CSV in one invocation (stay under CPU)
      const small = [329, 11027, 10342, 9833, 9375, 9821, 288, 11129, 9717, 9091];
      const start = Number(url.searchParams.get("offset") || 0);
      const batch = small.slice(start, start + 2);
      const fotmob = [];
      for (const id of batch) {
        fotmob.push({
          id,
          label: WARM_FOTMOB_LEAGUES.find((x) => x.id === id)?.label,
          ...(await warmFotmobLeague(id)),
        });
      }
      const csv = await warmFdCsvDiv("E0");
      return NextResponse.json({
        ok: true,
        source: "all-small",
        offset: start,
        nextOffset: start + 2,
        fotmob,
        csv,
        tip: "Repeat with ?source=all-small&offset=N until done; also ?source=csv&div=D1 etc.",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: "unknown source",
        sources: ["fotmob", "csv", "openliga", "all-small"],
        leagues: WARM_FOTMOB_LEAGUES,
      },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
