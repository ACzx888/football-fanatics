import { MatchBoard } from "@/components/MatchBoard";
import { fetchMatchesPayload } from "@/lib/hkjc";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // SSR uses light (KV-only form) so Free Workers never 1102 on the homepage.
  // Client refresh hits /api/matches which may do a tiny 0-sample network fill.
  const initial = await fetchMatchesPayload({ light: true });
  return <MatchBoard initial={initial} />;
}
