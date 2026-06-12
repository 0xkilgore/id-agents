// W-004 subprocess-timeout reliability fix.
//
// The claude-code-cli harness spawns the agent process during dispatch with
// no timeout watchdog: a child blocked on stdin (the "Not logged in · Please
// run /login" interactive prompt) or a stalled network call hangs the
// dispatch forever and fails silently. These tests cover the two pure pieces
// of the fix: how the effective timeout is resolved, and the SIGTERM→SIGKILL
// kill-timer that the spawn arms.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HARNESS_TIMEOUT_MS,
  armProcessTimeout,
  resolveHarnessTimeoutMs,
} from "../../src/harness/claude-code-cli.js";

describe("resolveHarnessTimeoutMs", () => {
  it("defaults to DEFAULT_HARNESS_TIMEOUT_MS when nothing is set", () => {
    expect(resolveHarnessTimeoutMs({}, {})).toBe(DEFAULT_HARNESS_TIMEOUT_MS);
  });

  it("prefers an explicit option over the env and the default", () => {
    expect(
      resolveHarnessTimeoutMs({ timeoutMs: 1234 }, { ID_AGENT_HARNESS_TIMEOUT_MS: "9999" }),
    ).toBe(1234);
  });

  it("falls back to the env var when no option is given", () => {
    expect(resolveHarnessTimeoutMs({}, { ID_AGENT_HARNESS_TIMEOUT_MS: "60000" })).toBe(60000);
  });

  it("treats 0 as an explicit disable (no watchdog)", () => {
    expect(resolveHarnessTimeoutMs({ timeoutMs: 0 }, {})).toBe(0);
    expect(resolveHarnessTimeoutMs({}, { ID_AGENT_HARNESS_TIMEOUT_MS: "0" })).toBe(0);
  });

  it("ignores a garbage / negative env value and uses the default", () => {
    expect(resolveHarnessTimeoutMs({}, { ID_AGENT_HARNESS_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_HARNESS_TIMEOUT_MS,
    );
    expect(resolveHarnessTimeoutMs({}, { ID_AGENT_HARNESS_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_HARNESS_TIMEOUT_MS,
    );
  });

  it("default is a generous backstop (>= 5 minutes) so legit long runs are not killed", () => {
    expect(DEFAULT_HARNESS_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe("armProcessTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeProc() {
    return {
      killed: false,
      signals: [] as string[],
      kill(sig: string) {
        this.signals.push(sig);
        return true;
      },
    };
  }

  it("does nothing when timeoutMs <= 0 (disabled)", () => {
    const proc = fakeProc();
    const onTimeout = vi.fn();
    const clear = armProcessTimeout(proc, 0, { graceMs: 2000, onTimeout });
    vi.advanceTimersByTime(10_000_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.signals).toEqual([]);
    clear(); // safe no-op
  });

  it("fires onTimeout + SIGTERM at the timeout, then SIGKILL after the grace period", () => {
    const proc = fakeProc();
    const onTimeout = vi.fn();
    armProcessTimeout(proc, 30_000, { graceMs: 2000, onTimeout });

    vi.advanceTimersByTime(29_999);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.signals).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(proc.signals).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(2000);
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does NOT SIGKILL if the process already exited during the grace period", () => {
    const proc = fakeProc();
    armProcessTimeout(proc, 30_000, { graceMs: 2000, onTimeout: () => {} });
    vi.advanceTimersByTime(30_000);
    expect(proc.signals).toEqual(["SIGTERM"]);
    proc.killed = true; // process closed on its own after SIGTERM
    vi.advanceTimersByTime(2000);
    expect(proc.signals).toEqual(["SIGTERM"]); // no SIGKILL
  });

  it("clear() cancels the watchdog so a process that finishes in time is never signalled", () => {
    const proc = fakeProc();
    const onTimeout = vi.fn();
    const clear = armProcessTimeout(proc, 30_000, { graceMs: 2000, onTimeout });
    vi.advanceTimersByTime(10_000);
    clear();
    vi.advanceTimersByTime(10_000_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.signals).toEqual([]);
  });
});
