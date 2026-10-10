/**
 * OpenNext custom Worker: fetch + Cloudflare cron.
 * - Every 10 minutes → /api/odds/collect mode=full (board + Pin priority batch; Refresh uses lean)
 * - 0 22 / 0 4 / 0 10 UTC → Fanatics warm-ext (HKT 06/12/18)
 */
import { default as handler } from "./.open-next/worker.js";

const ORIGIN = "https://football-fanatics.zx888s.workers.dev";
const WARM_CSV_OFFSET_KEY = "warm:v1:cron-csv-offset";
const CSV_DIVS = ["E0", "E1", "SP1", "D1", "I1", "F1"];
const WARM_CRONS = new Set(["0 22 * * *", "0 4 * * *", "0 10 * * *"]);

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type WorkerEnv = CloudflareEnv & {
  HISTORIC_CACHE: Kv;
  ODDS_KV?: Kv;
  PUBLIC_ORIGIN?: string;
  COLLECT_SECRET?: string;
};

type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void;
};

type ScheduledController = { cron: string; scheduledTime?: number };

async function warmOnce(env: WorkerEnv): Promise<void> {
  const kv = env.HISTORIC_CACHE;
  let csvOffset = 0;
  try {
    csvOffset = Number((await kv.get(WARM_CSV_OFFSET_KEY)) || 0) || 0;
  } catch {
    csvOffset = 0;
  }

  const csvDiv = CSV_DIVS[csvOffset % CSV_DIVS.length];
  const boardUrl = `${ORIGIN}/api/warm-ext?source=board`;
  const csvUrl = `${ORIGIN}/api/warm-ext?source=csv&div=${csvDiv}`;

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

  const hour = new Date().getUTCHours();
  if (hour === 4) {
    tasks.push(fetch(`${ORIGIN}/api/warm-ext?source=openliga`));
  }

  await Promise.allSettled(tasks);
}

async function runOddsCollect(env: WorkerEnv): Promise<void> {
  const origin = env.PUBLIC_ORIGIN || ORIGIN;
  const secret = env.COLLECT_SECRET;
  const url = new URL("/api/odds/collect", origin);
  if (secret) url.searchParams.set("secret", secret);
  const res = await fetch(url.toString(), { method: "GET" });
  const text = await res.text();
  console.log("odds-collect", res.status, text.slice(0, 300));
}

const worker = {
  fetch: handler.fetch as (
    request: Request,
    env: WorkerEnv,
    ctx: WaitUntilCtx
  ) => Promise<Response> | Response,

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: WaitUntilCtx
  ) {
    if (WARM_CRONS.has(controller.cron)) {
      ctx.waitUntil(warmOnce(env));
      return;
    }
    // Default: every-10m odds collect (and any other cron)
    ctx.waitUntil(runOddsCollect(env));
  },
};

export default worker;

export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "./.open-next/worker.js";
