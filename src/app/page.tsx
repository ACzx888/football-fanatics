import { MatchBoard } from "@/components/MatchBoard";
import { fetchMatchesPayload } from "@/lib/hkjc";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const initial = await fetchMatchesPayload();
  return <MatchBoard initial={initial} />;
}
