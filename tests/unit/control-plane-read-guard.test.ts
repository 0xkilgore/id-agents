// P0 control-plane Slice 1 — read-path protection middleware (unit).
//
// Deterministic: fake req/res + fake timers. Covers shouldGuard classification,
// the counting semaphore (admit <= cap, excess 503, slot freed on settle), the
// per-request timeout (503 {busy}), and that writes/health bypass the guard.

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  shouldGuard,
  busyBody,
  createReadGuard,
  DEFAULT_PROTECTED_PREFIXES,
} from "../../src/control-plane/read-guard.js";

function fakeReq(method: string, path: string) {
  return { method, path } as never;
}

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.statusCode = 200;
  res.headersSent = false;
  res.body = undefined;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.headersSent = true; res.body = b; res.emit("finish"); return res; };
  return res;
}

describe("shouldGuard", () => {
  const P = DEFAULT_PROTECTED_PREFIXES;
  it("guards GET on protected prefixes (exact + nested)", () => {
    expect(shouldGuard("GET", "/dispatches", P)).toBe(true);
    expect(shouldGuard("GET", "/dispatches/abc", P)).toBe(true);
    expect(shouldGuard("GET", "/agents", P)).toBe(true);
    expect(shouldGuard("GET", "/agents/roger/detail", P)).toBe(true);
    expect(shouldGuard("GET", "/outputs/inbox", P)).toBe(true);
  });
  it("never guards writes (the daemon burst must not be shed)", () => {
    expect(shouldGuard("POST", "/dispatches/x/accept", P)).toBe(false);
    expect(shouldGuard("PATCH", "/agents/roger/catalog", P)).toBe(false);
  });
  it("never guards health probes (exact /health and */health)", () => {
    expect(shouldGuard("GET", "/health", P)).toBe(false);
    expect(shouldGuard("GET", "/dispatches/health", P)).toBe(false);
  });
  it("ignores unprotected read paths", () => {
    expect(shouldGuard("GET", "/loops", P)).toBe(false);
    expect(shouldGuard("GET", "/usage/runtime-mix", P)).toBe(false);
  });
  it("does not treat a prefix as a substring match", () => {
    // "/agents-archive" must NOT match the "/agents" prefix.
    expect(shouldGuard("GET", "/agents-archive", P)).toBe(false);
  });
});

describe("busyBody", () => {
  it("shapes the 503 payload", () => {
    expect(busyBody("overloaded", { in_flight: 3 })).toEqual({
      ok: false, error: "busy", reason: "overloaded", in_flight: 3,
    });
    expect(busyBody("timeout", { timeout_ms: 2500 })).toMatchObject({ error: "busy", reason: "timeout" });
  });
});

describe("createReadGuard — semaphore", () => {
  it("admits up to maxConcurrent, then sheds excess with 503 (does not queue)", () => {
    const guard = createReadGuard({ maxConcurrent: 2, timeoutMs: 9999 });
    const open: ReturnType<typeof fakeRes>[] = [];
    // Two slow reads occupy both slots (next() called, response left open).
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      let nexted = false;
      guard.middleware(fakeReq("GET", "/agents"), res as never, () => { nexted = true; });
      expect(nexted).toBe(true);
      open.push(res);
    }
    expect(guard.inFlight()).toBe(2);

    // Third is shed immediately — 503, next() NOT called.
    const third = fakeRes();
    let thirdNexted = false;
    guard.middleware(fakeReq("GET", "/agents"), third as never, () => { thirdNexted = true; });
    expect(thirdNexted).toBe(false);
    expect(third.statusCode).toBe(503);
    expect(third.body).toMatchObject({ error: "busy", reason: "overloaded" });
    expect(guard.inFlight()).toBe(2);

    // When one settles, the slot frees and a new read is admitted.
    open[0].emit("finish");
    expect(guard.inFlight()).toBe(1);
    const fourth = fakeRes();
    let fourthNexted = false;
    guard.middleware(fakeReq("GET", "/agents"), fourth as never, () => { fourthNexted = true; });
    expect(fourthNexted).toBe(true);
    expect(guard.inFlight()).toBe(2);
  });

  it("bypasses non-guarded requests without touching the semaphore", () => {
    const guard = createReadGuard({ maxConcurrent: 1 });
    const res = fakeRes();
    let nexted = false;
    guard.middleware(fakeReq("POST", "/dispatches"), res as never, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(guard.inFlight()).toBe(0);
    // /health too
    guard.middleware(fakeReq("GET", "/health"), fakeRes() as never, () => {});
    expect(guard.inFlight()).toBe(0);
  });

  it("frees the slot on an aborted connection (close)", () => {
    const guard = createReadGuard({ maxConcurrent: 1, timeoutMs: 9999 });
    const res = fakeRes();
    guard.middleware(fakeReq("GET", "/agents"), res as never, () => {});
    expect(guard.inFlight()).toBe(1);
    res.emit("close");
    expect(guard.inFlight()).toBe(0);
  });
});

describe("createReadGuard — timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("answers 503 {busy,timeout} when a read exceeds timeoutMs and frees the slot", () => {
    vi.useFakeTimers();
    const guard = createReadGuard({ maxConcurrent: 1, timeoutMs: 2500 });
    const res = fakeRes();
    guard.middleware(fakeReq("GET", "/dispatches"), res as never, () => {/* slow handler, never responds */});
    expect(guard.inFlight()).toBe(1);
    expect(res.headersSent).toBe(false);

    vi.advanceTimersByTime(2500);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: "busy", reason: "timeout", timeout_ms: 2500 });
    expect(guard.inFlight()).toBe(0);
  });

  it("does not double-send if the handler already responded before the timeout", () => {
    vi.useFakeTimers();
    const guard = createReadGuard({ maxConcurrent: 1, timeoutMs: 2500 });
    const res = fakeRes();
    guard.middleware(fakeReq("GET", "/agents"), res as never, () => { res.status(200).json({ ok: true }); });
    expect(res.statusCode).toBe(200);
    expect(guard.inFlight()).toBe(0);
    // Advancing past the timeout must not flip the already-sent response.
    vi.advanceTimersByTime(5000);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
