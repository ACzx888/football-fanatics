import { HistoryBoard } from "@/components/HistoryBoard";
import { getPredictionsPayload } from "@/lib/prediction-log";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const initial = await getPredictionsPayload();
  return <HistoryBoard initial={initial} />;
}
