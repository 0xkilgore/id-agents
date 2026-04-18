import { execFile } from 'child_process';

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Bucket boundaries in bytes — bucketing keeps the rendered string stable
// across small RSS jitter so memo'd rows don't repaint every poll.
const PER_AGENT_BUCKET = 16 * MB;
const TOTAL_BUCKET = 64 * MB;

function bucket(bytes: number, step: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.floor(bytes / step) * step;
}

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const b = bucket(bytes, PER_AGENT_BUCKET);
  if (b < GB) {
    return `${Math.max(0, Math.round(b / MB))}MB`;
  }
  // 1 decimal of precision for GB, dropped if integer.
  const gb = b / GB;
  const rounded = Math.round(gb * 10) / 10;
  if (rounded === Math.floor(rounded)) return `${rounded.toFixed(0)}GB`;
  return `${rounded.toFixed(1)}GB`;
}

export function formatTotalMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0MB';
  const b = bucket(bytes, TOTAL_BUCKET);
  if (b < GB) return `${Math.max(0, Math.round(b / MB))}MB`;
  const gb = b / GB;
  const rounded = Math.round(gb * 10) / 10;
  if (rounded === Math.floor(rounded)) return `${rounded.toFixed(0)}GB`;
  return `${rounded.toFixed(1)}GB`;
}

export function memoryColor(bytes: number | null | undefined): string {
  if (bytes == null) return 'gray';
  if (bytes < 200 * MB) return 'green';
  if (bytes < 500 * MB) return 'yellow';
  return 'red';
}

export function totalMemoryColor(bytes: number): string {
  if (bytes < 2 * GB) return 'green';
  if (bytes < 6 * GB) return 'yellow';
  return 'red';
}

/**
 * Resolve RSS for a set of pids via a single batched `ps` invocation.
 * Returns a map keyed by pid → bytes. Pids the OS no longer knows about
 * are simply absent from the map — callers fall back to `—`.
 */
export function fetchRssForPids(
  pids: number[],
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    const filtered = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (filtered.length === 0) {
      resolve(new Map());
      return;
    }
    // `-o pid=,rss=` suppresses headers; rss is in KB on macOS and Linux.
    const args = ['-o', 'pid=,rss=', '-p', filtered.join(',')];
    const child = execFile('ps', args, { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(new Map());
        return;
      }
      const out = new Map<number, number>();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [pidStr, rssStr] = trimmed.split(/\s+/);
        const pid = Number(pidStr);
        const rssKb = Number(rssStr);
        if (Number.isFinite(pid) && Number.isFinite(rssKb)) {
          out.set(pid, rssKb * 1024);
        }
      }
      resolve(out);
    });
    if (signal) {
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
