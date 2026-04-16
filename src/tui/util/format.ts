export function humanizeUptime(startMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (s < 60) return 'new';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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

