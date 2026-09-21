"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FootballMatch, MatchesApiResponse } from "@/lib/types";
import { Disclaimer } from "./Disclaimer";
import { ErrorBanner } from "./ErrorBanner";
import { Header } from "./Header";
import { MatchCard } from "./MatchCard";

const REFRESH_MS = 45_000;

type Filter = "all" | "today" | "tomorrow" | "inplay";

export function MatchBoard({ initial }: { initial: MatchesApiResponse }) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/matches", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MatchesApiResponse;
      setData(json);
      setLastError(null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const hasInPlay = useMemo(
    () => data.matches.some((m) => m.isInPlay),
    [data.matches]
  );

  useEffect(() => {
    const ms = hasInPlay ? REFRESH_MS : 90_000;
    const id = setInterval(() => {
      void refresh();
    }, ms);
    return () => clearInterval(id);
  }, [hasInPlay, refresh]);

  const filtered = useMemo(() => {
    let list: FootballMatch[] = data.matches;
    if (filter === "today") list = list.filter((m) => m.dayBucket === "today");
    if (filter === "tomorrow")
      list = list.filter((m) => m.dayBucket === "tomorrow");
    if (filter === "inplay") list = list.filter((m) => m.isInPlay);
    return list;
  }, [data.matches, filter]);

  const todayCount = data.matches.filter((m) => m.dayBucket === "today").length;
  const tmrCount = data.matches.filter((m) => m.dayBucket === "tomorrow").length;
  const inplayCount = data.matches.filter((m) => m.isInPlay).length;

  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: data.matches.length },
    { id: "today", label: "Today", count: todayCount },
    { id: "tomorrow", label: "Tomorrow", count: tmrCount },
    { id: "inplay", label: "In-Play", count: inplayCount },
  ];

  return (
    <div className="min-h-screen bg-pitch-950 text-slate-100">
      <Header
        today={data.today}
        tomorrow={data.tomorrow}
        source={data.source}
        matchCount={data.matchCount}
        fetchedAt={data.fetchedAt}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {(data.error || data.source === "demo") && data.error && (
          <ErrorBanner message={data.error} />
        )}
        {lastError && (
          <ErrorBanner message={`Client refresh error: ${lastError}`} />
        )}
        {data.historicNote && (
          <p className="mb-4 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-[11px] text-slate-500">
            {data.historicNote}
          </p>
        )}

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilter(t.id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  filter === t.id
                    ? "bg-accent text-pitch-950 shadow-lg shadow-accent/20"
                    : "border border-slate-700 bg-slate-900/50 text-slate-300 hover:border-accent/40"
                }`}
              >
                {t.label}{" "}
                <span className="opacity-70">({t.count})</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:border-accent/50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-16 text-center">
            <p className="text-lg font-medium text-slate-300">
              No matches in this view
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Try another filter or refresh. Schedule covers today &amp;
              tomorrow (HKT) only.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filtered.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        )}

        <footer className="mt-10 space-y-3 border-t border-slate-800 pt-6">
          <Disclaimer />
          <p className="text-center text-[11px] text-slate-600">
            Auto-refresh every {hasInPlay ? "45s" : "90s"}
            {hasInPlay ? " (in-play matches detected)" : ""}. Minute clock is
            estimated from kickoff + status when HKJC does not expose match
            minute.
          </p>
        </footer>
      </main>
    </div>
  );
}
