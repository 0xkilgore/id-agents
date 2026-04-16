export function humanizeUptime(startMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad2(h)}:${pad2(m)}`;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

export function humanizeAge(tsMs: number | undefined, nowMs: number = Date.now()): string {
  if (!tsMs) return '—';
  const s = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (s < 60) return `${s}s`;
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

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
