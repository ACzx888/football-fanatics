/**
 * OpenNext custom Worker: re-export fetch + Cloudflare cron (scheduled).
 * Cron hits /api/warm-ext in small chunks a few times per day (HKT).
 *
 * Schedules (UTC) ≈ HKT 06:00 / 12:00 / 18:00:
 *   0 22 * * *  → 06:00 HKT
 *   0 4 * * *   → 12:00 HKT
 *   0 10 * * *  → 18:00 HKT
 */
// Generated at `opennextjs-cloudflare build` time
import { default as handler } from "./.open-next/worker.js";

const WARM_BASE = "https://football-fanatics.zx888s.workers.dev";
const WARM_OFFSET_KEY = "warm:v1:cron-offset";
const WARM_CSV_OFFSET_KEY = "warm:v1:cron-csv-offset";
const FOTMOB_CHUNK = 2;
/** Small-league id list length used by /api/warm-ext?source=all-small */
const FOTMOB_SMALL_LEN = 10;
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
  let offset = 0;
  let csvOffset = 0;
  try {
    offset = Number((await kv.get(WARM_OFFSET_KEY)) || 0) || 0;
    csvOffset = Number((await kv.get(WARM_CSV_OFFSET_KEY)) || 0) || 0;
  } catch {
    offset = 0;
    csvOffset = 0;
  }

  const allSmallUrl = `${WARM_BASE}/api/warm-ext?source=all-small&offset=${offset}`;
  const csvDiv = CSV_DIVS[csvOffset % CSV_DIVS.length];
  const csvUrl = `${WARM_BASE}/api/warm-ext?source=csv&div=${csvDiv}`;

  const tasks: Promise<unknown>[] = [
    fetch(allSmallUrl).then(async (r) => {
      try {
        const j = (await r.json()) as { nextOffset?: number };
        const next = j.nextOffset ?? offset + FOTMOB_CHUNK;
        const wrapped = next >= FOTMOB_SMALL_LEN ? 0 : next;
        await kv.put(WARM_OFFSET_KEY, String(wrapped));
      } catch {
        // ignore parse/kv
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

// Re-export OpenNext Durable Objects used by the adapter cache layer
export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "./.open-next/worker.js";
