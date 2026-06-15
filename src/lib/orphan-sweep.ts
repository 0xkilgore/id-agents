// R.1 orphan-process sweep.
//
// The manager spawns agent servers with `spawn(..., { detached: true })` +
// `proc.unref()`, so they intentionally outlive the manager. The downside: if
// the manager crashes/restarts, those children become ORPHANS that keep their
// ports and burn RAM with no supervisor. On startup the manager sweeps for
// agent-server processes that aren't owned by the current run and kills them,
// so no zombie subprocess survives across restarts.
//
// The decision is pure (findOrphans); listing + killing are injected so the
// behavior is unit-testable without real processes. The default real
// implementation uses `pgrep` (listed) and `process.kill` (killed).

import { runWithTimeout } from "./subprocess.js";

export interface ProcEntry {
  pid: number;
  command: string;
  /** Elapsed seconds since the process started (from `ps -o etimes`). */
  etimeSec?: number;
}

export interface FindOrphansOptions {
  /** Only treat a process as an orphan once it is at least this old. Protects
   *  freshly-spawned children from a racing sweep. Default 0. */
  minAgeSec?: number;
}

/**
 * Pure: processes that are NOT owned by the current run (not in keepPids, not
 * this process), and at least `minAgeSec` old.
 */
export function findOrphans(
  procs: readonly ProcEntry[],
  keepPids: ReadonlySet<number>,
  opts: FindOrphansOptions = {},
): ProcEntry[] {
  const minAgeSec = opts.minAgeSec ?? 0;
  const self = process.pid;
  return procs.filter((p) => {
    if (p.pid === self) return false;
    if (keepPids.has(p.pid)) return false;
    if (minAgeSec > 0 && (p.etimeSec ?? Number.POSITIVE_INFINITY) < minAgeSec) return false;
    return true;
  });
}

export interface SweepOptions {
  listProcesses: () => ProcEntry[];
  keepPids: ReadonlySet<number>;
  /** Kill a pid. Default sends the signal via process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  minAgeSec?: number;
  /** Signal to kill orphans with. Default SIGTERM, then nothing — these are
   *  servers that handle SIGTERM cleanly; escalate via a second sweep. */
  signal?: NodeJS.Signals;
}

export interface SweepReport {
  scanned: number;
  orphan_pids: number[];
  killed: number;
  errors: number;
  list_error: string | null;
}

/**
 * Find and kill orphan agent-server processes. Never throws — a sweep failure
 * must not crash manager startup.
 */
export async function sweepOrphanAgents(opts: SweepOptions): Promise<SweepReport> {
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const signal = opts.signal ?? "SIGTERM";
  const report: SweepReport = {
    scanned: 0,
    orphan_pids: [],
    killed: 0,
    errors: 0,
    list_error: null,
  };

  let procs: ProcEntry[];
  try {
    procs = opts.listProcesses();
  } catch (err) {
    report.list_error = err instanceof Error ? err.message : String(err);
    return report;
  }
  report.scanned = procs.length;

  const orphans = findOrphans(procs, opts.keepPids, { minAgeSec: opts.minAgeSec });
  report.orphan_pids = orphans.map((o) => o.pid);
  for (const orphan of orphans) {
    try {
      kill(orphan.pid, signal);
      report.killed += 1;
    } catch {
      report.errors += 1;
    }
  }
  return report;
}

/**
 * Real process lister: `pgrep -f <pattern>` for PIDs, then `ps -o pid=,etimes=,command=`
 * for age + command. Returns [] on any failure (the sweep degrades gracefully).
 * Timeout-bounded so a wedged `pgrep`/`ps` cannot hang startup.
 */
export function listMatchingProcesses(pattern: string): ProcEntry[] {
  const pg = runWithTimeout("pgrep", ["-f", pattern], { timeoutMs: 5000 });
  if (!pg.ok) return [];
  const pids = pg.stdout
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) return [];

  const out: ProcEntry[] = [];
  for (const pid of pids) {
    const ps = runWithTimeout("ps", ["-o", "etimes=,command=", "-p", String(pid)], {
      timeoutMs: 5000,
    });
    if (!ps.ok) {
      out.push({ pid, command: pattern });
      continue;
    }
    const line = ps.stdout.trim();
    const m = line.match(/^(\d+)\s+(.*)$/);
    out.push({
      pid,
      etimeSec: m ? Number(m[1]) : undefined,
      command: m ? m[2] : line,
    });
  }
  return out;
}
