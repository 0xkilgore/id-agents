// P0 control-plane hardening — Slice 1: read-path protection middleware.
//
// Root cause (cto/output/2026-06-24-control-plane-pressure-mitigation-plan.md):
// the manager shares ONE synchronous better-sqlite3 connection between the
// daemon write-burst and heavy read endpoints. A big synchronous SELECT blocks
// the event loop; concurrent reads pile up against busy_timeout while a cheap
// /health COUNT still answers. There is no read protection, dedup, or
// backpressure today.
//
// This middleware is the smallest safe slice: purely additive Express
// middleware that protects the heavy READ endpoints (never writes, never
// /health). It does three things:
//   (a) per-request timeout — a guarded read that hasn't answered within
//       timeoutMs gets a 503 {busy} instead of hanging the caller,
//   (b) a counting semaphore — at most `maxConcurrent` heavy reads run at once;
//       excess is SHED immediately with 503 (load-shed, not queue), so a read
//       storm can't deepen the event-loop backlog,
//   (c) (handled at the route layer) a LIMIT/result cap so a list read can't
//       full-scan-then-sort unbounded.
//
// No daemon/orchestration code, no schema change, fully reversible (drop the
// `.use()` line and the module). The governor and orchestration stay paused.

import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface ReadGuardOptions {
  /** Max concurrent guarded reads before excess is shed with 503. */
  maxConcurrent?: number;
  /** Per-request budget; a guarded read past this answers 503 {busy}. */
  timeoutMs?: number;
  /** GET path prefixes that are guarded. */
  protectedPrefixes?: string[];
}

export interface ReadGuard {
  middleware: RequestHandler;
  /** Current number of in-flight guarded reads (telemetry / tests). */
  inFlight(): number;
}

export const DEFAULT_PROTECTED_PREFIXES = ["/dispatches", "/agents", "/outputs/inbox"];
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_TIMEOUT_MS = 2500;

/**
 * Whether a request is a heavy read this guard should protect. Pure.
 *
 * - GET only — writes (the daemon's burst) are never shed.
 * - Health probes always pass: exact `/health` and any path ending in
 *   `/health` (e.g. `/dispatches/health`) stay reachable so liveness survives
 *   contention.
 * - Otherwise guarded iff the path equals or is nested under a protected prefix.
 */
export function shouldGuard(method: string, pathName: string, prefixes: string[]): boolean {
  if (method !== "GET") return false;
  if (pathName === "/health" || pathName.endsWith("/health")) return false;
  return prefixes.some((p) => pathName === p || pathName.startsWith(p + "/"));
}

/** The 503 body the guard sends when it sheds or times out a read. */
export function busyBody(reason: "overloaded" | "timeout", detail: Record<string, unknown> = {}) {
  return { ok: false, error: "busy", reason, ...detail };
}

/**
 * Build the read-guard middleware + an in-flight accessor. The middleware
 * self-filters via `shouldGuard`, so it is safe to mount globally with
 * `app.use()` ahead of the routes.
 */
export function createReadGuard(opts: ReadGuardOptions = {}): ReadGuard {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefixes = opts.protectedPrefixes ?? DEFAULT_PROTECTED_PREFIXES;

  let inFlight = 0;

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!shouldGuard(req.method, req.path, prefixes)) return next();

    // (b) Counting semaphore — shed, don't queue.
    if (inFlight >= maxConcurrent) {
      res.status(503).json(busyBody("overloaded", { in_flight: inFlight, max_concurrent: maxConcurrent }));
      return;
    }

    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
      clearTimeout(timer);
    };

    // Free the slot whenever the response settles (success, error, or abort).
    res.on("finish", release);
    res.on("close", release);

    // (a) Per-request timeout — answer 503 rather than hang the caller. The
    // underlying handler may still complete later; we free the slot now so the
    // semaphore reflects responsiveness, not raw occupancy.
    const timer = setTimeout(() => {
      if (released) return;
      if (!res.headersSent) {
        res.status(503).json(busyBody("timeout", { timeout_ms: timeoutMs }));
      }
      release();
    }, timeoutMs);
    // Don't keep the process alive for a pending guard timer.
    if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();

    next();
  };

  return { middleware, inFlight: () => inFlight };
}
