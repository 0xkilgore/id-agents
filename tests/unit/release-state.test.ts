import { describe, expect, it } from "vitest";
import {
  assessCheckout,
  assessOpsLock,
  cleanSafelyRemovableOpsLocks,
  parseLockPid,
  type CheckoutProbe,
  type ReleaseState,
} from "../../src/deploy-guard/release-state.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function checkout(over: Partial<CheckoutProbe> = {}): CheckoutProbe {
  return {
    exists: true,
    is_git: true,
    branch: "main",
    intended_branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty_count: 0,
    status_short: "",
    ...over,
  };
}

describe("Kapelle release-state checkout assessment", () => {
  it("is green only for clean main matching origin/main", () => {
    const r = assessCheckout(checkout());
    expect(r.severity).toBe("green");
    expect(r.code).toBe("clean_main");
  });

  it("is red when kapelle-site is serving a feature branch", () => {
    const r = assessCheckout(checkout({ branch: "feat/render-fix" }));
    expect(r.severity).toBe("red");
    expect(r.code).toBe("off_main");
    expect(r.remediation).toMatch(/checkout main/);
    expect(r.remediation).toMatch(/rebuild, restart/);
  });

  it("is red when kapelle-site has uncommitted changes", () => {
    const r = assessCheckout(checkout({ dirty_count: 2, status_short: " M app/ops/page.tsx" }));
    expect(r.severity).toBe("red");
    expect(r.code).toBe("dirty");
    expect(r.message).toMatch(/2 uncommitted/);
  });

  it("is yellow for divergent local main vs origin/main", () => {
    const r = assessCheckout(checkout({ ahead: 1, behind: 1 }));
    expect(r.severity).toBe("yellow");
    expect(r.code).toBe("ahead_or_behind");
    expect(r.remediation).toMatch(/Fast-forward/);
  });
});

describe("Kapelle ops lock assessment", () => {
  it("parses plain and JSON lock owner pids", () => {
    expect(parseLockPid("1234\n")).toBe(1234);
    expect(parseLockPid('{"pid":4321,"script":"rebuild"}')).toBe(4321);
    expect(parseLockPid("owner pid: 7777")).toBe(7777);
  });

  it("marks dead owner PID locks as safely removable", () => {
    const r = assessOpsLock({
      path: "/repo/.ops-build.lock",
      name: ".ops-build.lock",
      exists: true,
      owner_pid: 1234,
      owner_alive: false,
      live_server_pid: 9999,
      mtime_ms: 1,
      raw: "1234",
    });
    expect(r.severity).toBe("yellow");
    expect(r.code).toBe("stale_pid");
    expect(r.safely_removable).toBe(true);
  });

  it("marks live lock owner mismatch vs live next-server PID as red", () => {
    const r = assessOpsLock({
      path: "/repo/.ops-supervisor.lock",
      name: ".ops-supervisor.lock",
      exists: true,
      owner_pid: 1234,
      owner_alive: true,
      live_server_pid: 9999,
      mtime_ms: 1,
      raw: "1234",
    });
    expect(r.severity).toBe("red");
    expect(r.code).toBe("owner_mismatch");
    expect(r.safely_removable).toBe(false);
    expect(r.remediation).toMatch(/live next-server PID 9999/);
  });

  it("cleans only locks classified as safely removable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-state-locks-"));
    const stale = path.join(dir, ".ops-build.lock");
    const active = path.join(dir, ".ops-supervisor.lock");
    fs.writeFileSync(stale, "111");
    fs.writeFileSync(active, "222");

    const state: ReleaseState = {
      repo_dir: dir,
      observed_at: "2026-06-27T00:00:00.000Z",
      status: "yellow",
      checkout: assessCheckout(checkout()),
      locks: [
        assessOpsLock({
          path: stale,
          name: ".ops-build.lock",
          exists: true,
          owner_pid: 111,
          owner_alive: false,
          live_server_pid: 222,
          mtime_ms: 1,
          raw: "111",
        }),
        assessOpsLock({
          path: active,
          name: ".ops-supervisor.lock",
          exists: true,
          owner_pid: 222,
          owner_alive: true,
          live_server_pid: 222,
          mtime_ms: 1,
          raw: "222",
        }),
      ],
      actions: [],
    };

    expect(cleanSafelyRemovableOpsLocks(dir, state)).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
