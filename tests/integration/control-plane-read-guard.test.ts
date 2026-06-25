// P0 control-plane Slice 1 — read-path protection middleware (integration).
//
// Real Express app on an EPHEMERAL port (:0, never a fixed port — avoids the
// port-contention flakiness that plagues the fixed-port integration suite).
// Proves end-to-end wiring: a slow guarded read 503s at the timeout and excess
// concurrency is shed, while /health stays 200 under contention, and an
// uncontended read passes through unchanged.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createReadGuard } from "../../src/control-plane/read-guard.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  // Tight budgets so the test is fast + deterministic: 1 slot, 120ms timeout.
  const guard = createReadGuard({ maxConcurrent: 1, timeoutMs: 120 });
  app.use(guard.middleware);

  // Guarded + slow: holds the single slot ~300ms (exceeds the 120ms budget).
  app.get("/agents", async (_req, res) => {
    await sleep(300);
    if (!res.headersSent) res.json({ ok: true, agents: [] });
  });
  // Guarded + fast: the uncontended/regression path.
  app.get("/dispatches", (_req, res) => res.json({ ok: true, dispatches: [] }));
  // Never guarded: liveness must survive contention.
  app.get("/health", (_req, res) => res.json({ ok: true, status: "healthy" }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("read-guard integration", () => {
  it("REGRESSION: an uncontended guarded read passes through unchanged (200)", async () => {
    const r = await fetch(`${base}/dispatches`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("a slow guarded read is answered 503 {busy,timeout} at the budget", async () => {
    const r = await fetch(`${base}/agents`);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "busy", reason: "timeout" });
  });

  it("sheds excess concurrency with 503 while /health stays 200 under contention", async () => {
    // Fire two slow reads + a health probe together. With one slot, the first
    // read holds it; the second is shed; health bypasses the guard entirely.
    const [a, b, health] = await Promise.all([
      fetch(`${base}/agents`),
      fetch(`${base}/agents`),
      fetch(`${base}/health`),
    ]);
    const statuses = [a.status, b.status].sort();
    // One slot → at least one 503; health always 200.
    expect(statuses).toContain(503);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy" });

    const shed = [a, b].find((r) => r.status === 503)!;
    expect(await shed.json()).toMatchObject({ error: "busy" });
  });

  it("recovers the slot after contention clears (subsequent read admitted)", async () => {
    await sleep(200); // let any prior slow handlers + timeouts settle
    const r = await fetch(`${base}/dispatches`);
    expect(r.status).toBe(200);
  });
});
