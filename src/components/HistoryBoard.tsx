"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  PredictionRecord,
  PredictionSummary,
  PredictionsApiResponse,
} from "@/lib/prediction-log";
import { Disclaimer } from "./Disclaimer";
import { ErrorBanner } from "./ErrorBanner";
import { SiteNav } from "./SiteNav";

function formatKickoff(iso: string): string {
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: "Asia/Hong_Kong",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

function VerdictBadge({ rec }: { rec: PredictionRecord }) {
  if (rec.settleStatus === "pending") {
    return (
      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
        Pending
      </span>
    );
  }
  if (rec.settleStatus === "void") {
    return (
      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400">
        Void
      </span>
    );
  }
  if (!rec.had.available || rec.hadCorrect == null) {
    return (
      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400">
        No HAD
      </span>
    );
  }
  if (rec.hadCorrect) {
    return (
      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
        Correct
      </span>
    );
  }
  return (
    <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-400 ring-1 ring-rose-500/30">
      Wrong
    </span>
  );
}

function SummarySection({ summary }: { summary: PredictionSummary }) {
  return (
    <div className="mb-8 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Settled HAD"
          value={String(summary.hadSettled)}
          sub={`${summary.pending} pending · ${summary.total} total`}
        />
        <StatCard
          label="HAD accuracy"
          value={
            summary.hadAccuracyPct != null
              ? `${summary.hadAccuracyPct}%`
              : "—"
          }
          sub={
            summary.hadSettled > 0
              ? `${summary.hadCorrect} / ${summary.hadSettled} correct`
              : "Awaiting results"
          }
        />
        <StatCard
          label="Avg conf (correct)"
          value={
            summary.avgConfidenceCorrect != null
              ? `${summary.avgConfidenceCorrect}%`
              : "—"
          }
        />
        <StatCard
          label="Avg conf (wrong)"
          value={
            summary.avgConfidenceWrong != null
              ? `${summary.avgConfidenceWrong}%`
              : "—"
          }
        />
      </div>

      {summary.byLeague.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 px-4 py-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
            By league (settled HAD)
          </p>
          <div className="flex flex-wrap gap-2">
            {summary.byLeague.slice(0, 12).map((row) => (
              <div
                key={row.league}
                className="rounded-lg border border-slate-800 bg-black/30 px-2.5 py-1.5 text-xs"
              >
                <span className="text-slate-300">{row.league}</span>{" "}
                <span className="font-mono text-accent">
                  {row.accuracyPct != null ? `${row.accuracyPct}%` : "—"}
                </span>
                <span className="text-slate-500">
                  {" "}
                  ({row.correct}/{row.settled})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.cornersCompared > 0 && (
        <p className="text-xs text-slate-500">
          Corners within ±1.5 of expected: {summary.cornersClose}/
          {summary.cornersCompared}
        </p>
      )}
    </div>
  );
}

function RecordRow({ rec }: { rec: PredictionRecord }) {
  const score =
    rec.homeScore != null && rec.awayScore != null
      ? `${rec.homeScore}–${rec.awayScore}`
      : "—";
  const cornerExp =
    rec.totalCorners.available && rec.totalCorners.expected != null
      ? `~${rec.totalCorners.expected}`
      : "—";
  const cornerAct = rec.corners != null ? String(rec.corners) : "—";

  return (
    <tr className="border-b border-slate-800/80 hover:bg-white/[0.02]">
      <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-slate-400">
        {formatKickoff(rec.kickOffTime)}
        <div className="mt-0.5 text-[10px] text-slate-600">{rec.league}</div>
      </td>
      <td className="px-3 py-3 align-top text-sm text-slate-100">
        <span className="font-medium">{rec.homeTeam}</span>
        <span className="text-slate-500"> vs </span>
        <span className="font-medium">{rec.awayTeam}</span>
        <div className="mt-0.5 font-mono text-[10px] text-slate-600">
          #{rec.frontEndId || rec.matchId}
        </div>
      </td>
      <td className="px-3 py-3 align-top text-sm">
        {rec.had.available ? (
          <>
            <span className="font-semibold text-white">
              {rec.had.pick ?? rec.had.pickCode}
            </span>
            {rec.had.confidencePct != null && (
              <span className="ml-1.5 text-xs text-slate-400">
                {rec.had.confidencePct}%
              </span>
            )}
            {rec.hadActual && rec.settleStatus === "settled" && (
              <div className="mt-0.5 text-[10px] text-slate-500">
                actual {rec.hadActual}
              </div>
            )}
          </>
        ) : (
          <span className="text-xs text-slate-500">Insufficient</span>
        )}
      </td>
      <td className="px-3 py-3 align-top font-mono text-sm text-slate-200">
        {score}
      </td>
      <td className="px-3 py-3 align-top">
        <VerdictBadge rec={rec} />
      </td>
      <td className="px-3 py-3 align-top text-xs text-slate-400">
        <span className="font-mono">{cornerExp}</span>
        <span className="mx-1 text-slate-600">→</span>
        <span className="font-mono text-slate-200">{cornerAct}</span>
        {rec.cornersClose === true && (
          <span className="ml-1 text-emerald-500">≈</span>
        )}
        {rec.cornersClose === false && (
          <span className="ml-1 text-rose-400">≠</span>
        )}
      </td>
    </tr>
  );
}

export function HistoryBoard({ initial }: { initial: PredictionsApiResponse }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/predictions", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PredictionsApiResponse;
      setData(json);
      setLastError(null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, 120_000);
    return () => clearInterval(id);
  }, [refresh]);

  const fetchedLabel = new Intl.DateTimeFormat("en-HK", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(data.fetchedAt));

  return (
    <div className="min-h-screen bg-pitch-950 text-slate-100">
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
                  Prediction Track Record
                </div>
                <SiteNav active="history" />
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Accuracy <span className="text-accent">History</span>
              </h1>
              <p className="mt-2 text-base text-slate-300 sm:text-lg">
                Past fundamental HAD picks vs final HKJC results
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-right backdrop-blur">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Last check
              </p>
              <p className="font-mono text-sm text-white">{fetchedLabel} HKT</p>
              <p className="mt-1 text-xs text-slate-400">
                {data.settledThisCall > 0
                  ? `Settled ${data.settledThisCall} this load`
                  : "Lazy settle on load"}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {data.error && <ErrorBanner message={data.error} />}
        {lastError && (
          <ErrorBanner message={`Client refresh error: ${lastError}`} />
        )}

        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:border-accent/50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh / settle"}
          </button>
        </div>

        <SummarySection summary={data.summary} />

        {data.records.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-16 text-center">
            <p className="text-lg font-medium text-slate-300">
              No prediction records yet
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Open the Home board so live HKJC matches are fetched — each
              successful prediction is logged automatically (demo fixtures are
              skipped). Results settle after kickoff (~2.5h) or when HKJC posts
              full-time scores.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-900/40">
            <table className="min-w-full text-left">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-3 font-medium">Kickoff (HKT)</th>
                  <th className="px-3 py-3 font-medium">Match</th>
                  <th className="px-3 py-3 font-medium">HAD pick</th>
                  <th className="px-3 py-3 font-medium">Score</th>
                  <th className="px-3 py-3 font-medium">Result</th>
                  <th className="px-3 py-3 font-medium">Corners exp→act</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((rec) => (
                  <RecordRow key={rec.key} rec={rec} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <footer className="mt-10 space-y-3 border-t border-slate-800 pt-6">
          <p className="text-center text-[11px] leading-relaxed text-slate-500">
            HAD accuracy = settled picks where the model&apos;s Home/Draw/Away
            choice matches the final 1X2. Corners marked ≈ when |expected −
            actual| ≤ 1.5 (skipped when HKJC corner data is missing). No odds
            stored.
          </p>
          <Disclaimer />
        </footer>
      </main>
    </div>
  );
}
