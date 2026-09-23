import { SiteNav } from "./SiteNav";

export function Header({
  today,
  tomorrow,
  source,
  matchCount,
  fetchedAt,
}: {
  today: string;
  tomorrow: string;
  source: "live" | "demo";
  matchCount: number;
  fetchedAt: string;
}) {
  const fetchedLabel = new Intl.DateTimeFormat("en-HK", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(fetchedAt));

  return (
    <header className="relative overflow-hidden border-b border-pitch-800/80 bg-gradient-to-br from-pitch-950 via-pitch-900 to-slate-950">
      <div className="pointer-events-none absolute inset-0 opacity-30">
        <div className="absolute -left-20 top-0 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
        <div className="absolute -right-10 bottom-0 h-48 w-48 rounded-full bg-emerald-600/20 blur-3xl" />
      </div>
      <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_#22c55e]" />
                Fundamental Match Desk
              </div>
              <SiteNav active="home" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Football<span className="text-accent">Fanatics</span>
            </h1>
            <p className="mt-2 text-base text-slate-300 sm:text-lg">
              Purly Fundemental Analysis for Football Lovers!
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-right backdrop-blur">
            <p className="text-xs uppercase tracking-wide text-slate-400">
              Window (HKT)
            </p>
            <p className="font-mono text-sm text-white">
              {today} → {tomorrow}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {source === "live" ? (
                <span className="text-accent">● Live HKJC</span>
              ) : (
                <span className="text-amber-400">● Demo data</span>
              )}{" "}
              · {matchCount} matches · {fetchedLabel} HKT
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
