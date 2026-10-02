import { NextResponse } from "next/server";
import { invalidateBoardCache } from "@/lib/board-cache";
import {
  warmFdCsvDiv,
  warmFotmobLeague,
  warmOpenLiga,
  WARM_FOTMOB_LEAGUES,
} from "@/lib/ext-form";

export const dynamic = "force-dynamic";

/**
 * Warm external form indexes into HISTORIC_CACHE (one step per call).
 * Cron / manual: keep this warm so /api/matches stays KV-only and never 1102.
 *
 * ## Cron (Cloudflare Worker scheduled — see wrangler.jsonc + custom-worker.ts)
 * HKT 06:00 / 12:00 / 18:00 ≈ UTC 22:00 / 04:00 / 10:00
 * Each run: `all-small` chunk (2 FotMob leagues) + one football-data CSV div;
 * offset advances in KV (`warm:v1:cron-offset`). Midday also warms openliga.
 *
 * ## Manual / external scheduler URLs
 *   GET /api/warm-ext?source=all-small&offset=0   (then offset=2,4,…)
 *   GET /api/warm-ext?source=fotmob&id=9821
 *   GET /api/warm-ext?source=csv&div=E0
 *   GET /api/warm-ext?source=openliga
 *   GET /api/warm-ext?source=status              (docs + schedule)
 *
 * Tip: 3×/day is enough — board predictions use long KV TTL; do not warm on every page load.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "all-small";

  try {
    if (source === "status") {
      return NextResponse.json({
        ok: true,
        source: "status",
        purpose:
          "Warm public form indexes a few times per day; /api/matches stays KV-first (board:v1:today-tomorrow).",
        cron: {
          wrangler: ["0 22 * * *", "0 4 * * *", "0 10 * * *"],
          hkt: ["06:00", "12:00", "18:00"],
          utc: ["22:00", "04:00", "10:00"],
          eachRun: [
            "GET /api/warm-ext?source=all-small&offset=<kv warm:v1:cron-offset>",
            "GET /api/warm-ext?source=csv&div=<rotating E0,E1,SP1,D1,I1,F1>",
            "At 12:00 HKT also GET /api/warm-ext?source=openliga",
          ],
          externalFallback: [
            "https://football-fanatics.zx888s.workers.dev/api/warm-ext?source=all-small&offset=0",
            "https://football-fanatics.zx888s.workers.dev/api/warm-ext?source=all-small&offset=2",
            "https://football-fanatics.zx888s.workers.dev/api/warm-ext?source=csv&div=E0",
          ],
        },
        boardCache: {
          key: "board:v1:today-tomorrow",
          ttlSec: 10800,
          httpMaxAgePreEvent: 300,
          httpMaxAgeInPlay: 30,
          note: "Board KV ~3h; in-play freshness via live overlay. Warm success invalidates board cache.",
        },
        leagues: WARM_FOTMOB_LEAGUES,
      });
    }

    if (source === "fotmob") {
      const idParam = url.searchParams.get("id");
      const id = idParam ? Number(idParam) : WARM_FOTMOB_LEAGUES[0]?.id;
      if (!id || !Number.isFinite(id)) {
        return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
      }
      const result = await warmFotmobLeague(id);
      const label =
        WARM_FOTMOB_LEAGUES.find((x) => x.id === id)?.label || String(id);
      if (result.ok) await invalidateBoardCache();
      return NextResponse.json({ ok: result.ok, source: "fotmob", id, label, result });
    }

    if (source === "csv") {
      const div = url.searchParams.get("div") || "E0";
      const result = await warmFdCsvDiv(div);
      if (result.ok) await invalidateBoardCache();
      return NextResponse.json({ ok: result.ok, source: "csv", div, result });
    }

    if (source === "openliga") {
      const result = await warmOpenLiga();
      if (result.ok) await invalidateBoardCache();
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
      const anyOk = fotmob.some((f) => f.ok) || csv.ok;
      if (anyOk) await invalidateBoardCache();
      return NextResponse.json({
        ok: true,
        source: "all-small",
        offset: start,
        nextOffset: start + 2,
        fotmob,
        csv,
        boardInvalidated: anyOk,
        tip: "Repeat with ?source=all-small&offset=N until done; also ?source=csv&div=D1 etc. Cron: see ?source=status",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: "unknown source",
        sources: ["fotmob", "csv", "openliga", "all-small", "status"],
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
