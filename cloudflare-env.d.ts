/**
 * Minimal Cloudflare Workers env bindings for FootballFanatics.
 * Full runtime types: `npm run cf-typegen`
 */
interface FfKvNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareEnv {
  HISTORIC_CACHE: FfKvNamespace;
  ASSETS?: { fetch: typeof fetch };
  NEXTJS_ENV?: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
