// Spec 054 v2 Part 2 Step 8 integration: /agent-done warn/enforce behaviour
// + enqueue-side promotion metadata propagation.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

let port: number;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;
let baseUrl: string;
let workDir: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-done-promo-"));
  baseUrl = `http://127.0.0.1:${port}`;
  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);
  const defaultTeamId = await db.teams.getOrCreateTeamId("default");
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [defaultTeamId, "agent_coder_max", "coder-max", "persistent", "claude-opus", 24000, "http://127.0.0.1:19999", "active", Date.now(), "claude-code"],
  );
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 200);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  // Reset enforcement mode after each test (we mutate process.env in some).
  delete process.env.SPEC054_PROMOTION_ENFORCEMENT;
});

async function enqueue(opts: {
  repo?: string;
  branch?: string;
  promote?: boolean;
  promotion_skip_reason?: string;
}) {
  const handle = (manager as any).dispatchScheduler;
  return handle.enqueue({
    to_agent: "coder-max",
    from_actor: "manager",
    message: "build the thing",
    subject: opts.repo ? `build ${opts.branch}` : "non-build dispatch",
    repo: opts.repo,
    branch: opts.branch,
    promote: opts.promote,
    promotion_skip_reason: opts.promotion_skip_reason,
  });
}

async function claim(phid: string) {
  const handle = (manager as any).dispatchScheduler;
  await handle.reactor.claim({ max_in_flight: 10 });
  return handle.reactor.getByPhid(phid);
}

describe("enqueue promotion metadata propagation", () => {
  it("repo + branch propagate to DispatchDoc.promotion_input and default promote=true", async () => {
    const enq = await enqueue({ repo: "/abs/repo-A", branch: "feat-x" });
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(enq.dispatch_phid);
    expect(doc.promote).toBe(true);
    expect(doc.promotion_input).toMatchObject({
      repo: "/abs/repo-A",
      branch: "feat-x",
      base: "main",
      remote: "origin",
    });
  });

  it("non-build dispatch (no repo/branch) defaults promote=false; promotion_input=null", async () => {
    const enq = await enqueue({});
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(enq.dispatch_phid);
    expect(doc.promote).toBe(false);
    expect(doc.promotion_input).toBeNull();
  });

  // Spec 054 v2 Part 2 review-fix (2026-05-24): explicit promote=false
  // on a build dispatch MUST carry a non-empty promotion_skip_reason.
  // Without one, enqueue rejects so the bypass leaves an audit trigger.
  it("explicit promote=false on a build dispatch with NO skip reason is REJECTED", async () => {
    await expect(
      enqueue({ repo: "/abs/repo-B", branch: "wip", promote: false }),
    ).rejects.toThrow(/non-empty promotion_skip_reason/);
  });

  it("explicit promote=false with a whitespace-only skip reason is REJECTED", async () => {
    await expect(
      enqueue({
        repo: "/abs/repo-B",
        branch: "wip",
        promote: false,
        promotion_skip_reason: "   ",
      }),
    ).rejects.toThrow(/non-empty promotion_skip_reason/);
  });

  it("explicit promote=false WITH a non-empty skip reason is accepted and recorded", async () => {
    const enq = await enqueue({
      repo: "/abs/repo-B",
      branch: "wip",
      promote: false,
      promotion_skip_reason: "WIP — revisit when smoke spec is final",
    });
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(enq.dispatch_phid);
    expect(doc.promote).toBe(false);
    expect(doc.promotion_input).toMatchObject({
      repo: "/abs/repo-B",
      branch: "wip",
      promotion_skip_reason: "WIP — revisit when smoke spec is final",
    });
    // promotion_required_reason mirrors the skip reason for the audit trail.
    expect(doc.promotion_required_reason).toBe("WIP — revisit when smoke spec is final");
  });

  it("non-build dispatch with promote=false (default) does NOT require a skip reason", async () => {
    const enq = await enqueue({ promote: false });
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(enq.dispatch_phid);
    expect(doc.promote).toBe(false);
    expect(doc.promotion_input).toBeNull();
  });

  it("POST /dispatch/enqueue forwards promotion_input metadata and inherits central build dedup", async () => {
    const payload = {
      to_agent: "coder-max",
      from_actor: "operator",
      message: "build the route",
      subject: "operator build",
      promote: true,
      promotion_strategy: "merge_commit",
      promotion_input: {
        repo: "/abs/repo-route",
        branch: "feat-route",
        base: "main",
        remote: "origin",
      },
    };

    const first = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; dispatch_phid: string };
    expect(firstBody.ok).toBe(true);

    const second = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, message: "build the route again" }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { ok: boolean; dispatch_phid: string };
    expect(secondBody.dispatch_phid).toBe(firstBody.dispatch_phid);

    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(firstBody.dispatch_phid);
    expect(doc.promote).toBe(true);
    expect(doc.promotion_strategy).toBe("merge_commit");
    expect(doc.promotion_input).toMatchObject({
      repo: "/abs/repo-route",
      branch: "feat-route",
      base: "main",
      remote: "origin",
    });
  });

  it("POST /dispatch/enqueue allow_duplicate bypasses central build dedup", async () => {
    const payload = {
      to_agent: "coder-max",
      from_actor: "operator",
      message: "build duplicate route",
      promotion_input: {
        repo: "/abs/repo-route-dup",
        branch: "feat-route",
      },
    };

    const first = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const firstBody = await first.json() as { dispatch_phid: string };

    const second = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, allow_duplicate: true }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { dispatch_phid: string };
    expect(secondBody.dispatch_phid).not.toBe(firstBody.dispatch_phid);
  });
});

describe("POST /agent-done — warn mode (default)", () => {
  it("build dispatch + missing promotion payload => 200 with promotion_warning", async () => {
    const enq = await enqueue({ repo: "/abs/repo-warn", branch: "f1" });
    await claim(enq.dispatch_phid);
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        result: { tldr: "shipped" },
        // no promotion payload
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("warn");
    expect(body.promotion_warning).toMatch(/missing promotion metadata/);
    expect(body.state).toBe("done");
  });

  it("non-build dispatch + missing promotion payload => 200 with no warning", async () => {
    const enq = await enqueue({});
    await claim(enq.dispatch_phid);
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.promotion_warning).toBeNull();
  });
});

describe("POST /agent-done — enforce mode", () => {
  it("build dispatch + missing promotion payload => 400", async () => {
    const enq = await enqueue({ repo: "/abs/repo-enf", branch: "f2" });
    await claim(enq.dispatch_phid);
    const r = await fetch(`${baseUrl}/agent-done?mode=enforce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        mode: "enforce", // override env
      }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing promotion metadata/);
    expect(body.mode).toBe("enforce");
  });

  it("env SPEC054_PROMOTION_ENFORCEMENT=enforce is honoured", async () => {
    process.env.SPEC054_PROMOTION_ENFORCEMENT = "enforce";
    const enq = await enqueue({ repo: "/abs/repo-env", branch: "f3" });
    await claim(enq.dispatch_phid);
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dispatch_id: enq.dispatch_phid, success: true }),
    });
    expect(r.status).toBe(400);
  });

  it("build dispatch + complete valid promotion => 200, promotion persisted", async () => {
    const enq = await enqueue({ repo: "/abs/repo-ok", branch: "f4" });
    await claim(enq.dispatch_phid);
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        mode: "enforce",
        promotion: {
          required: true,
          completed: true,
          repos: [
            {
              path: "/abs/repo-ok",
              base: "main",
              source_branch: "f4",
              strategy: "fast_forward",
              promoted_sha: "abc123",
              remote_main_sha: "abc123",
              pushed: true,
              verified: true,
            },
          ],
        },
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.promotion_warning).toBeNull();

    // promotion_result column was populated
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(enq.dispatch_phid);
    expect(doc.status).toBe("done");
    expect(doc.promotion_result).toMatchObject({ completed: true });
  });
});

describe("POST /agent-done — input validation", () => {
  it("rejects missing dispatch_id and query_id with 400", async () => {
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }),
    });
    expect(r.status).toBe(400);
  });

  it("accepts unknown dispatch_id as ignored non-scheduler closeout", async () => {
    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dispatch_id: "phid:disp-deadbeef", success: true }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      dispatch_id: "phid:disp-deadbeef",
      state: "ignored_non_scheduler",
      ignored: true,
      reason: "dispatch_not_found",
    });
  });
});

// Queued-dispatch closeout (Spec 2026-06-01-queued-dispatch-closeout-spec.md).
// Verifies the operator-facing /agent-done endpoint can terminally close
// a dispatch that is still `queued` (the scheduler never claimed it).
// Pre-fix this returned 500 with "markDoneWithResult requires in_flight".
describe("POST /agent-done — queued-dispatch closeout (out-of-band success)", () => {
  it("closes a still-queued non-build dispatch as done with persisted result", async () => {
    const enq = await enqueue({ /* non-build, queued, never ticked */ });

    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        result: { artifact_path: "/tmp/spec.md" },
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.dispatch_id).toBe(enq.dispatch_phid);
    expect(body.state).toBe("done");

    // Persisted state — row is `done` with the result JSON round-tripped.
    const reactor = (manager as any).dispatchScheduler.reactor;
    const doc = await reactor.getByPhid(enq.dispatch_phid);
    expect(doc.status).toBe("done");
    expect(doc.completed_at).not.toBeNull();
    const result = await reactor.getResult(enq.dispatch_phid);
    expect(result).toEqual({ artifact_path: "/tmp/spec.md" });
  });

  it("idempotent: a second /agent-done is a terminal no-op (no 500, state stays done)", async () => {
    const enq = await enqueue({});

    const first = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        result: { artifact_path: "/tmp/first.md" },
      }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        result: { artifact_path: "/tmp/second.md" },
      }),
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.state).toBe("done");

    // First result wins (terminal no-op semantics).
    const reactor = (manager as any).dispatchScheduler.reactor;
    const result = await reactor.getResult(enq.dispatch_phid);
    expect(result).toEqual({ artifact_path: "/tmp/first.md" });
  });

  it("queued failure path still works via markFailed (existing behavior unchanged)", async () => {
    const enq = await enqueue({});

    const r = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: false,
        failure_kind: "agent_error",
        error: "failed mid-async",
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.state).toBe("failed");

    const reactor = (manager as any).dispatchScheduler.reactor;
    const doc = await reactor.getByPhid(enq.dispatch_phid);
    expect(doc.status).toBe("failed");
    expect(doc.failure_kind).toBe("agent_error");
    expect(doc.failure_detail).toContain("failed mid-async");
  });
});
