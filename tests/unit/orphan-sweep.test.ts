// R.1 orphan-process sweep: on startup, detached agent-server children from a
// previous manager run can survive as orphans (the spawn is `detached`+`unref`).
// The sweep finds them (by command pattern), excludes the PIDs the current run
// owns, and kills the rest — so no zombie subprocess survives across restarts.

import { describe, expect, it, vi } from "vitest";
import {
  type ProcEntry,
  findOrphans,
  sweepOrphanAgents,
} from "../../src/lib/orphan-sweep.js";

function proc(pid: number, command = "node local-agent-server.js", etimeSec = 9999): ProcEntry {
  return { pid, command, etimeSec };
}

describe("findOrphans (pure decision)", () => {
  it("returns processes whose PID is not in the keep set", () => {
    const orphans = findOrphans([proc(1), proc(2), proc(3)], new Set([2]));
    expect(orphans.map((o) => o.pid)).toEqual([1, 3]);
  });

  it("never returns a kept PID even if many match", () => {
    const orphans = findOrphans([proc(10), proc(11), proc(12)], new Set([10, 11, 12]));
    expect(orphans).toEqual([]);
  });

  it("with minAgeSec, excludes freshly-started processes (avoids killing this run's children)", () => {
    const orphans = findOrphans(
      [proc(1, "node local-agent-server.js", 5), proc(2, "node local-agent-server.js", 4000)],
      new Set(),
      { minAgeSec: 60 },
    );
    expect(orphans.map((o) => o.pid)).toEqual([2]); // pid 1 is only 5s old
  });

  it("excludes the current process pid defensively", () => {
    const self = process.pid;
    const orphans = findOrphans([proc(self), proc(999)], new Set());
    expect(orphans.map((o) => o.pid)).toEqual([999]);
  });
});

describe("sweepOrphanAgents", () => {
  it("kills every orphan and returns a typed report", async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const report = await sweepOrphanAgents({
      listProcesses: () => [proc(1), proc(2), proc(3)],
      keepPids: new Set([2]),
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
    expect(report.scanned).toBe(3);
    expect(report.orphan_pids.sort()).toEqual([1, 3]);
    expect(report.killed).toBe(2);
    expect(killed.map((k) => k.pid).sort()).toEqual([1, 3]);
  });

  it("counts kill failures without throwing (sweep must never crash startup)", async () => {
    const report = await sweepOrphanAgents({
      listProcesses: () => [proc(1)],
      keepPids: new Set(),
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(report.killed).toBe(0);
    expect(report.errors).toBe(1);
  });

  it("is a no-op when listing throws (degrade gracefully)", async () => {
    const report = await sweepOrphanAgents({
      listProcesses: () => {
        throw new Error("pgrep missing");
      },
      keepPids: new Set(),
      kill: vi.fn(),
    });
    expect(report.scanned).toBe(0);
    expect(report.killed).toBe(0);
    expect(report.list_error).toBeTruthy();
  });
});
