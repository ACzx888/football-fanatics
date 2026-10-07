import { NextResponse } from "next/server";
import { invalidateBoardCache } from "@/lib/board-cache";
import {
  warmBoardTeamIndex,
  warmFdCsvDiv,
  warmFotmobLeague,
  warmOpenLiga,
  WARM_FOTMOB_LEAGUES,
} from "@/lib/ext-form";

export const dynamic = "force-dynamic";

/**
 * Warm external form indexes into HISTORIC_CACHE (one step per call).
 * Prefer ?source=board — builds extform:v2:board-teams for O(1) /api/matches merge.
 *
 * Cron (see wrangler.jsonc + custom-worker.ts): board warm each run; CSV rotates.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || "board";

  try {
    if (source === "status") {
      return NextResponse.json({
        ok: true,
        source: "status",
        purpose:
          "Warm board-teams index a few times per day; /api/matches stays KV-first O(1).",
        cron: {
          wrangler: ["0 22 * * *", "0 4 * * *", "0 10 * * *"],
          hkt: ["06:00", "12:00", "18:00"],
          eachRun: [
            "GET /api/warm-ext?source=board",
            "GET /api/warm-ext?source=csv&div=<rotating>",
          ],
        },
        boardCache: {
          key: "board:v1:today-tomorrow",
          ttlSec: 10800,
          note: "Invalidate board cache only after source=board succeeds.",
        },
        leagues: WARM_FOTMOB_LEAGUES,
      });
    }

    if (source === "board") {
      const result = await warmBoardTeamIndex();
      if (result.ok || result.teamsIndexed > 0) {
        await invalidateBoardCache();
      }
      return NextResponse.json({
        ok: result.ok,
        source: "board",
        result,
        boardInvalidated: result.ok || result.teamsIndexed > 0,
        tip: "Matches path merges extform:v2:board-teams only (exact lookup).",
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
      // Do NOT invalidate board here — partial warm caused 1102 rebuild death spiral.
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
      // Legacy chunk warm — prefer source=board. Still useful to seed small idx:*.
      const small = [
        9011, 51, 535, 9469, 11027, 10342, 9091, 9821, 114, 329, 251, 9375,
      ];
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
      return NextResponse.json({
        ok: true,
        source: "all-small",
        offset: start,
        nextOffset: start + 2,
        fotmob,
        boardInvalidated: false,
        tip: "Use ?source=board to build board-teams + invalidate cache once.",
      });
    }

    return NextResponse.json(
      {
        ok: false,
        error: "unknown source",
        sources: ["board", "fotmob", "csv", "openliga", "all-small", "status"],
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
