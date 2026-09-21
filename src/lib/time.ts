const HKT = "Asia/Hong_Kong";

export function formatHktDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HKT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysHkt(base: Date, days: number): string {
  // Work in HKT calendar date space
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HKT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const utcNoon = new Date(Date.UTC(y, m - 1, d + days, 4, 0, 0)); // ~HKT noon
  return formatHktDate(utcNoon);
}

export function hktDateFromIso(iso: string): string {
  return formatHktDate(new Date(iso));
}

export function formatKickoffHkt(iso: string): string {
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: HKT,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatTimeHkt(iso: string): string {
  return new Intl.DateTimeFormat("en-HK", {
    timeZone: HKT,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Estimate match clock from kickoff + status (HKJC does not expose minute). */
export function estimateMinuteLabel(
  kickOffTime: string,
  status: string,
  now: Date = new Date()
): string | null {
  const s = status.toUpperCase();
  if (s === "HALFTIME" || s === "HT") return "HT";
  if (s === "FULLTIME" || s === "ENDED" || s === "FT") return "FT";
  if (!["FIRSTHALF", "SECONDHALF", "INPLAY", "LIVE"].includes(s)) return null;

  const kick = new Date(kickOffTime).getTime();
  if (Number.isNaN(kick)) return null;
  const elapsedMin = Math.max(0, Math.floor((now.getTime() - kick) / 60000));

  if (s === "FIRSTHALF") {
    if (elapsedMin <= 45) return `${elapsedMin}'`;
    return `45+${Math.min(elapsedMin - 45, 15)}'`;
  }
  if (s === "SECONDHALF") {
    // Assume ~15' half-time break
    const secondHalfElapsed = Math.max(0, elapsedMin - 60);
    const minute = 45 + secondHalfElapsed;
    if (minute <= 90) return `${minute}'`;
    return `90+${Math.min(minute - 90, 15)}'`;
  }
  // Generic in-play
  if (elapsedMin <= 45) return `${elapsedMin}'`;
  if (elapsedMin <= 60) return "HT";
  const m = Math.min(45 + (elapsedMin - 60), 90);
  return `${m}'`;
}

export function isInPlayStatus(status: string): boolean {
  const s = status.toUpperCase();
  return ["FIRSTHALF", "SECONDHALF", "HALFTIME", "INPLAY", "LIVE"].includes(s);
}
