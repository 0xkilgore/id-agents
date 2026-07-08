// Spec 054 v2 Part 2 Step 8 integration: /agent-done warn/enforce behaviour
// + enqueue-side promotion metadata propagation.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { artifactIdFromPath } from "../../src/outputs/storage.js";
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

  it("bare known repo aliases propagate as canonical promotion_input paths", async () => {
    const kapelle = await enqueue({ repo: "kapelle-site", branch: "feat-k" });
    const kapelleDoc = await (manager as any).dispatchScheduler.reactor.getByPhid(kapelle.dispatch_phid);
    expect(kapelleDoc.promotion_input?.repo).toBe("/Users/kilgore/Dropbox/Code/kapelle-site");

    const idAgents = await enqueue({ repo: "id-agents", branch: "feat-i" });
    const idAgentsDoc = await (manager as any).dispatchScheduler.reactor.getByPhid(idAgents.dispatch_phid);
    expect(idAgentsDoc.promotion_input?.repo).toBe("/Users/kilgore/Dropbox/Code/cane/id-agents");
  });

  it("rejects ambiguous relative repo names before enqueue persists metadata", async () => {
    await expect(enqueue({ repo: "other-repo", branch: "feat-x" })).rejects.toThrow(
      /enqueue: ambiguous relative repo name/,
    );
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

  async function postEnqueue(payload: Record<string, unknown>) {
    return fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to_agent: "coder-max",
        from_actor: "operator",
        ...payload,
      }),
    });
  }

  it("POST /dispatch/enqueue reuses an active dispatch with the same dedup_key", async () => {
    const dedupKey = "route-dedup-key";
    const payload = {
      message: "dedup this dispatch",
      subject: "dedup route",
      dedup_key: dedupKey,
    };

    const first = await postEnqueue(payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; dispatch_phid: string };
    expect(firstBody.ok).toBe(true);

    const second = await postEnqueue({ ...payload, message: "dedup this dispatch again" });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { ok: boolean; dispatch_phid: string };
    expect(secondBody.dispatch_phid).toBe(firstBody.dispatch_phid);

    const { rows } = await db.adapter.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dispatch_scheduler_queue WHERE dedup_key = ?`,
      [dedupKey],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });

  it("POST /dispatch/enqueue without dedup_key preserves separate dispatches", async () => {
    const first = await postEnqueue({ message: "old behavior first" });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { dispatch_phid: string };

    const second = await postEnqueue({ message: "old behavior second" });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { dispatch_phid: string };

    expect(secondBody.dispatch_phid).not.toBe(firstBody.dispatch_phid);
  });

  it("POST /dispatch/enqueue records build promotion_input and defaults base/remote", async () => {
    const res = await postEnqueue({
      message: "build with promotion input",
      promote: true,
      promotion_strategy: "merge_commit",
      promotion_input: {
        repo: "/abs/repo-route",
        branch: "feat-route",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { dispatch_phid: string };

    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(body.dispatch_phid);
    expect(doc.promote).toBe(true);
    expect(doc.promotion_strategy).toBe("merge_commit");
    expect(doc.promotion_input).toMatchObject({
      repo: "/abs/repo-route",
      branch: "feat-route",
      base: "main",
      remote: "origin",
    });
    expect(doc.promotion_required_reason).toBeNull();
  });

  it("POST /dispatch/enqueue rejects promote=false build promotion_input without a reason", async () => {
    const res = await postEnqueue({
      message: "build without promotion",
      promote: false,
      promotion_input: {
        repo: "/abs/repo-route-skip",
        branch: "feat-route",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/non-empty promotion_skip_reason/);
  });

  it("POST /dispatch/enqueue accepts promote=false build promotion_input with a reason", async () => {
    const res = await postEnqueue({
      message: "build without promotion with reason",
      promote: false,
      promotion_required_reason: "Long-lived branch; promote in follow-up",
      promotion_input: {
        repo: "/abs/repo-route-skip-ok",
        branch: "feat-route",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { dispatch_phid: string };

    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(body.dispatch_phid);
    expect(doc.promote).toBe(false);
    expect(doc.promotion_required_reason).toBe("Long-lived branch; promote in follow-up");
    expect(doc.promotion_input).toMatchObject({
      repo: "/abs/repo-route-skip-ok",
      branch: "feat-route",
      base: "main",
      remote: "origin",
    });
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
    expect(body.promotion.closeout_report).toMatchObject({
      required: true,
      status: "missing_required_evidence",
      reason_code: "missing_required_evidence",
    });
    expect(body.state).toBe("done");
  });

  it("non-build coordinator/no-code dispatch records explicit promotion-not-required reason", async () => {
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
    expect(body.receipt.promotion).toMatchObject({
      required: false,
      status: "not_required",
      reason_code: "coordinator_no_code",
      reason: "Coordinator/no-code dispatch; no repo/branch promotion required",
    });

    const list = await fetch(`${baseUrl}/dispatches?status=terminal`, {
      headers: { "X-Id-Team": "default" },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as any;
    const row = listBody.dispatches.find((d: any) => d.dispatch_id === enq.dispatch_phid);
    expect(row.promotion.closeout_report).toMatchObject({
      required: false,
      status: "not_required",
      reason_code: "coordinator_no_code",
    });
  });

  it("promote:false build closeout reports the recorded WIP/long-lived skip reason, not coordinator/no-code", async () => {
    const enq = await enqueue({
      repo: "/abs/repo-skip-closeout",
      branch: "wip-long-lived",
      promote: false,
      promotion_skip_reason: "WIP long-lived branch; revisit when follow-up dispatch lands",
    });
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
    const body = await r.json() as any;
    expect(body.promotion_warning).toBeNull();
    expect(body.receipt.promotion).toMatchObject({
      required: false,
      status: "skipped",
      reason_code: "promote_false_skip",
      reason: "WIP long-lived branch; revisit when follow-up dispatch lands",
    });

    const list = await fetch(`${baseUrl}/dispatches?status=terminal`, {
      headers: { "X-Id-Team": "default" },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as any;
    const row = listBody.dispatches.find((d: any) => d.dispatch_id === enq.dispatch_phid);
    expect(row.promotion.closeout_report).toMatchObject({
      required: false,
      status: "skipped",
      reason_code: "promote_false_skip",
      reason: "WIP long-lived branch; revisit when follow-up dispatch lands",
    });
  });
});

describe("POST /agent-done — fresh artifact registration", () => {
  it.each([
    {
      filename: "finance-fresh.md",
      content: "# Finance Artifact\n\nFresh markdown body.\n",
      renderer: "markdown",
      mediaType: "text/markdown",
      renderMimeType: "text/markdown; charset=utf-8",
      expectedText: "Fresh markdown body.",
    },
    {
      filename: "finance-fresh.html",
      content: "<!doctype html><h1>Finance Artifact</h1><p>Fresh HTML body.</p>\n",
      renderer: "html",
      mediaType: "text/html",
      renderMimeType: "text/html; charset=utf-8",
      expectedText: "Fresh HTML body.",
    },
  ])("registers and serves a fresh $renderer artifact by stable id", async ({ filename, content, renderer, mediaType, renderMimeType, expectedText }) => {
    const outputDir = path.join(workDir, "finance-project", "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const artifactPath = path.join(outputDir, filename);
    fs.writeFileSync(artifactPath, content);
    const expectedHash = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
    const artifactId = artifactIdFromPath(artifactPath);
    const enq = await enqueue({});
    await claim(enq.dispatch_phid);

    const done = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
        artifact_path: artifactPath,
        result: { artifact_path: artifactPath, tl_dr: "Fresh finance artifact" },
      }),
    });
    expect(done.status).toBe(200);
    fs.rmSync(artifactPath);

    const detail = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/detail`);
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.artifact_id).toBe(artifactId);
    expect(body.metadata).toMatchObject({
      basename: filename,
      agent: "coder-max",
      media_type: mediaType,
      content_hash: expectedHash,
      project_ref: "finance-project",
      dispatch_ref: enq.dispatch_phid,
      availability: "present",
    });
    expect(body.metadata.source_mtime).toEqual(expect.any(String));
    expect(body.metadata.source_size).toBe(Buffer.byteLength(content));
    expect(body.delivery).toMatchObject({
      sourcePath: artifactPath,
      bodyRenderable: true,
      bodyUnavailable: false,
      discoveredBy: "agent_done",
    });
    expect(body.body).toMatchObject({
      source: "artifact_body_cache",
      text: content,
      body_unavailable: false,
    });
    expect(body.body.text).toContain(expectedText);
    expect(body.render).toMatchObject({ renderer, mime_type: renderMimeType });
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
    expect(body.promotion.closeout_report).toMatchObject({
      required: true,
      status: "missing_required_evidence",
      reason_code: "missing_required_evidence",
    });
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
    const artifactRows = await db.adapter.query<{ abs_path: string; source: string; availability: string; dispatch_ref: string | null }>(
      `SELECT abs_path, source, availability, dispatch_ref
         FROM artifacts
        WHERE abs_path = ?`,
      ["/tmp/spec.md"],
    );
    expect(artifactRows.rows).toEqual([
      {
        abs_path: "/tmp/spec.md",
        source: "agent-done",
        availability: "missing",
        dispatch_ref: enq.dispatch_phid,
      },
    ]);
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
