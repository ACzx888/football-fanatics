/**
 * OpenNext custom Worker: re-export fetch + Cloudflare cron (scheduled).
 * Cron hits /api/warm-ext?source=board (builds board-teams index) a few times/day.
 *
 * Schedules (UTC) ≈ HKT 06:00 / 12:00 / 18:00:
 *   0 22 * * *  → 06:00 HKT
 *   0 4 * * *   → 12:00 HKT
 *   0 10 * * *  → 18:00 HKT
 */
import { default as handler } from "./.open-next/worker.js";

const WARM_BASE = "https://football-fanatics.zx888s.workers.dev";
const WARM_CSV_OFFSET_KEY = "warm:v1:cron-csv-offset";
const CSV_DIVS = ["E0", "E1", "SP1", "D1", "I1", "F1"];

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type WorkerEnv = CloudflareEnv & {
  HISTORIC_CACHE: Kv;
};

type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void;
};

async function warmOnce(env: WorkerEnv): Promise<void> {
  const kv = env.HISTORIC_CACHE;
  let csvOffset = 0;
  try {
    csvOffset = Number((await kv.get(WARM_CSV_OFFSET_KEY)) || 0) || 0;
  } catch {
    csvOffset = 0;
  }

  const csvDiv = CSV_DIVS[csvOffset % CSV_DIVS.length];
  const boardUrl = `${WARM_BASE}/api/warm-ext?source=board`;
  const csvUrl = `${WARM_BASE}/api/warm-ext?source=csv&div=${csvDiv}`;

  const tasks: Promise<unknown>[] = [
    fetch(boardUrl).then(async (r) => {
      try {
        await r.text();
      } catch {
        // ignore
      }
    }),
    fetch(csvUrl).then(async () => {
      try {
        await kv.put(
          WARM_CSV_OFFSET_KEY,
          String((csvOffset + 1) % CSV_DIVS.length)
        );
      } catch {
        // ignore
      }
    }),
  ];

  // Midday HKT (12:00 ≈ UTC 04:00) also warm openliga
  const hour = new Date().getUTCHours();
  if (hour === 4) {
    tasks.push(fetch(`${WARM_BASE}/api/warm-ext?source=openliga`));
  }

  await Promise.allSettled(tasks);
}

const worker = {
  fetch: handler.fetch as (
    request: Request,
    env: WorkerEnv,
    ctx: WaitUntilCtx
  ) => Promise<Response> | Response,

  async scheduled(
    _controller: { cron: string },
    env: WorkerEnv,
    ctx: WaitUntilCtx
  ) {
    ctx.waitUntil(warmOnce(env));
  },
};

export default worker;

export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "./.open-next/worker.js";
