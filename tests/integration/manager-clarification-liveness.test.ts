import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const baseDispatch: EnqueueInput = {
  query_id: "q-live-0",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "blocked projection",
  body_markdown: "x".repeat(4096),
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);

describe("manager clarification projection liveness", () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "manager-clar-live-"));
    adapter = new SqliteAdapter(join(tmpDir, "manager.db"));
    await migrateSqlite(adapter);
    await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-live', 'live')`);

    const reactor = new SqliteDispatchReactor({
      adapter,
      teamId: "team-live",
      now: () => "2026-07-13T12:45:00.000Z",
    });

    for (let i = 0; i < 160; i++) {
      const enq = await reactor.enqueue({
        ...baseDispatch,
        query_id: `q-live-${i}`,
        subject: `blocked projection ${i}`,
      });
      const claimed = await reactor.claim({ max_in_flight: 1000 });
      expect(claimed.claimed.length).toBe(1);
      await reactor.markNeedsClarification(enq.dispatch_phid, {
        agent_id: "roger",
        question: `clarify ${i}`,
        context: { payload: "y".repeat(4096) },
      });
    }

    const app = express();
    app.get("/health", (_req, res) => {
      res.json({ ok: true, status: "healthy" });
    });
    app.get("/dispatches/clarifications", async (_req, res) => {
      const docs = await reactor.listOpenClarifications({ limit: 25 });
      res.json({
        ok: true,
        count: docs.length,
        items: docs.map((d) => ({
          dispatch_id: d.dispatch_phid,
          subject: d.subject,
          question: d.active_clarification?.question ?? "",
        })),
      });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no ephemeral port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (adapter) await adapter.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps /health responsive while the clarification projection runs", async () => {
    const projection = fetch(`${baseUrl}/dispatches/clarifications`);
    const health = await withTimeout(fetch(`${baseUrl}/health`), 300);

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy" });

    const projected = await projection;
    expect(projected.status).toBe(200);
    expect(await projected.json()).toMatchObject({ ok: true, count: 25 });
  });
});
