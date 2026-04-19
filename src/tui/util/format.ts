export function humanizeUptime(startMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (s < 60) return 'new';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Humanize the age of a last_seen unix-seconds timestamp relative to now.
 * Returns a short string suitable for the UPTIME column of remote agents.
 * Returns '' if last_seen is null/undefined (never probed).
 */
export function humanizeLastSeen(lastSeenSec: number | null | undefined, nowMs: number): string {
  if (lastSeenSec == null || lastSeenSec <= 0) return '';
  const ageSec = Math.max(0, Math.floor((nowMs - lastSeenSec * 1000) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return `${s.slice(0, n - 1)}…`;
}

export function padRight(s: string, n: number): string {
  if (s.length >= n) return truncate(s, n);
  return s + ' '.repeat(n - s.length);
}

