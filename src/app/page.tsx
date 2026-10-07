import { MatchBoard } from "@/components/MatchBoard";
import { readBoardCache, mergeLiveOverlay } from "@/lib/board-cache";
import { fetchMatchesPayload } from "@/lib/hkjc";
import { buildDemoMatches } from "@/lib/demo-data";
import { addDaysHkt, formatHktDate } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Prefer KV board (predictions included) so Free Workers never 1102 on SSR.
  // Miss → light fixtures only; on failure → demo shell (client will retry API).
  let initial = null as Awaited<ReturnType<typeof fetchMatchesPayload>> | null;
  try {
    const hit = await readBoardCache();
    if (hit) {
      const merged = await mergeLiveOverlay(hit.payload);
      initial = merged.payload;
    }
  } catch {
    initial = null;
  }
  if (!initial) {
    try {
      initial = await fetchMatchesPayload({ light: true });
    } catch {
      const now = new Date();
      const demo = buildDemoMatches(now);
      initial = {
        ok: false,
        source: "demo",
        error: "Live board temporarily unavailable; showing demo shell.",
        timezone: "Asia/Hong_Kong",
        today: formatHktDate(now),
        tomorrow: addDaysHkt(now, 1),
        fetchedAt: now.toISOString(),
        matchCount: demo.length,
        matches: demo,
        historicNote: null,
        formCoverage: null,
        rawMatchCount: 0,
        filteredCount: 0,
      };
    }
  }
  return <MatchBoard initial={initial} />;
}
