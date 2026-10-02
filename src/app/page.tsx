import { MatchBoard } from "@/components/MatchBoard";
import { readBoardCache, mergeLiveOverlay } from "@/lib/board-cache";
import { fetchMatchesPayload } from "@/lib/hkjc";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Prefer KV board (predictions included) so Free Workers never 1102 on SSR.
  // Miss → light fixtures only; client refresh loads /api/matches (cache fill).
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
    initial = await fetchMatchesPayload({ light: true });
  }
  return <MatchBoard initial={initial} />;
}
