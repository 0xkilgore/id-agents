import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { reconcileStaleClarifications } from "../../src/dispatch-scheduler/clarification-ttl-reconciler.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const teamId = "team-clar-ttl";
const createdAt = "2026-07-13T10:00:00.000Z";
const staleNowIso = "2026-07-13T10:00:10.000Z";
const staleNowMs = Date.parse(staleNowIso);

const base: EnqueueInput = {
  query_id: "q-clar-ttl-1",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "promotion clarification",
  body_markdown: "finish promotion",
  provider: "openai",
  runtime: "codex",
  priority: 5,
};

let tmpDir: string;
let adapter: SqliteAdapter;
let events: SqliteEventsRepo;
let server: Server | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "clar-ttl-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  events = new SqliteEventsRepo(adapter);
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES (?, ?)`, [teamId, "test"]);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function reactor(): SqliteDispatchReactor {
  return new SqliteDispatchReactor({
    adapter,
    teamId,
    now: () => createdAt,
  });
}

async function enqueuePaused(
  r: SqliteDispatchReactor,
  input: {
    query_id: string;
    question: string;
    context: unknown;
  },
) {
  const enq = await r.enqueue({ ...base, query_id: input.query_id });
  await r.claim({ max_in_flight: 10 });
  const paused = await r.markNeedsClarification(enq.dispatch_phid, {
    agent_id: "roger",
    question: input.question,
    context: input.context,
    stale_ms: 1,
  });
  return paused;
}

async function startResumeEndpoint(): Promise<string> {
  server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/talk") {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ query_id: "query_resume_auto" }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind to a port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("reconcileStaleClarifications", () => {
  it("routes stale clarifications with a ready resume payload through the resume delivery path and emits a receipt", async () => {
    const r = reactor();
    const endpoint = await startResumeEndpoint();
    const paused = await enqueuePaused(r, {
      query_id: "q-ready-resume",
      question: "Promotion helper produced a ready answer. Resume?",
      context: {
        system: {
          recommended_option: "follow_up_dispatch",
          ready_resume_payload: {
            answer: "Use a clean follow-up promotion dispatch; do not merge the divergent source branch.",
            instructions: ["resume the original dispatch with the supplied promotion decision"],
          },
        },
      },
    });

    const result = await reconcileStaleClarifications({
      reactor: r,
      events,
      teamId,
      nowIso: staleNowIso,
      nowMs: staleNowMs,
      resolveEndpoint: async () => endpoint,
    });

    expect(result).toMatchObject({
      scanned: 1,
      auto_resumed: 1,
      needs_chris: 0,
      resume_delivery_failed: 0,
    });
    expect(result.items[0]).toMatchObject({
      dispatch_id: paused.doc.dispatch_phid,
      clarification_id: paused.clarification_id,
      action: "auto_resumed",
      recommended_option: "follow_up_dispatch",
      delivered_to_agent: true,
      agent_query_id: "query_resume_auto",
      event_seq: expect.any(Number),
    });
    const resumed = await r.getByPhid(paused.doc.dispatch_phid);
    expect(resumed?.status).toBe("queued");
    expect(resumed?.resume_delivery_status).toBe("delivered");
    expect(resumed?.clarification_history.map((event) => event.type)).toEqual([
      "NEEDS_CLARIFICATION",
      "RESUME",
      "RESUME_DELIVERED",
    ]);

    const rows = await events.query({ teamId, topics: ["dispatch:clarification_ttl_reconciled"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      schema_version: "dispatch.clarification_ttl_reconciled.v1",
      dispatch_id: paused.doc.dispatch_phid,
      clarification_id: paused.clarification_id,
      action: "auto_resumed",
      delivered_to_agent: true,
      agent_query_id: "query_resume_auto",
    });
  });

  it("surfaces a stale dirty-worktree clarification as needs_chris when no ready resume payload exists", async () => {
    const r = reactor();
    const paused = await enqueuePaused(r, {
      query_id: "q-dirty-non-auto",
      question: "Worktree is dirty; should I continue?",
      context: { git_status: " M src/agent-manager-db.ts", branch: "roger/fix-dispatch-health-liveness" },
    });

    const result = await reconcileStaleClarifications({
      reactor: r,
      events,
      teamId,
      nowIso: staleNowIso,
      nowMs: staleNowMs,
      resolveEndpoint: async () => null,
    });

    expect(result).toMatchObject({ scanned: 1, auto_resumed: 0, needs_chris: 1 });
    expect(result.items[0]).toMatchObject({
      dispatch_id: paused.doc.dispatch_phid,
      clarification_id: paused.clarification_id,
      action: "needs_chris",
      recommended_option: null,
      event_seq: expect.any(Number),
    });
    expect(result.items[0].blocker).toContain("Worktree is dirty; should I continue?");
    expect(result.items[0].blocker).toContain('"git_status":" M src/agent-manager-db.ts"');
    const stillPaused = await r.getByPhid(paused.doc.dispatch_phid);
    expect(stillPaused?.status).toBe("needs_clarification");
    expect(stillPaused?.clarification_history.some((event) => event.type === "CLARIFICATION_STALE")).toBe(true);
  });

  it("surfaces a stale divergent-branch clarification as needs_chris when recommended_option is not a ready resume payload", async () => {
    const r = reactor();
    const paused = await enqueuePaused(r, {
      query_id: "q-divergent-non-auto",
      question: "Promotion is blocked by divergent ancestry.",
      context: {
        ahead: 3,
        behind: 19,
        recommended_option: "follow_up_dispatch",
        options: ["merge_commit", "squash", "follow_up_dispatch"],
      },
    });

    const result = await reconcileStaleClarifications({
      reactor: r,
      events,
      teamId,
      nowIso: staleNowIso,
      nowMs: staleNowMs,
      resolveEndpoint: async () => null,
    });

    expect(result).toMatchObject({ scanned: 1, auto_resumed: 0, needs_chris: 1 });
    expect(result.items[0]).toMatchObject({
      dispatch_id: paused.doc.dispatch_phid,
      clarification_id: paused.clarification_id,
      action: "needs_chris",
      recommended_option: "follow_up_dispatch",
      event_seq: expect.any(Number),
    });
    expect(result.items[0].blocker).toContain("Promotion is blocked by divergent ancestry.");
    expect(result.items[0].blocker).toContain('"ahead":3');
    expect(result.items[0].blocker).toContain('"behind":19');
  });
});
