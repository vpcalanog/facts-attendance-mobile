// Timestamps arrive from three places — this device, another device via
// the server, and the server itself — so a malformed one is a real
// possibility. Without these guards a bad value rendered as "NaNm ago"
// and "Invalid Date" in the middle of the log.

function parse(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtRelative(iso: string): string {
  const d = parse(iso);
  if (!d) return "unknown time";
  const diffMs = Date.now() - d.getTime();
  // A timestamp from the future (clock skew between devices) reads oddly
  // as a negative age; treat anything within a minute either way as now.
  if (diffMs < 0) return "just now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function fmtTimestamp(iso: string): string {
  const d = parse(iso);
  if (!d) return "—";
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
    }
  )}`;
}

/** "Sep 24 · 08:00 AM – 09:30 AM", or just the start when there's no end. */
export function fmtTimeRange(startIso: string, endIso?: string | null): string {
  const start = fmtTimestamp(startIso);
  const end = endIso ? parse(endIso) : null;
  if (!end || start === "—") return start;
  return `${start} – ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function isToday(iso: string): boolean {
  const d = parse(iso);
  if (!d) return false;
  const t = new Date();
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
}
