export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-300">
          !
        </span>
        <div>
          <p className="font-semibold text-amber-200">Live data unavailable</p>
          <p className="mt-1 text-amber-100/90">{message}</p>
          <p className="mt-1 text-xs text-amber-200/70">
            Showing labeled demo fixtures so the UI remains usable.
          </p>
        </div>
      </div>
    </div>
  );
}
