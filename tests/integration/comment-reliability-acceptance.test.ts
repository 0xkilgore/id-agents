// T-QA comment reliability acceptance harness.
//
// Drives the manager outputs API over HTTP and verifies every comment submit has
// exactly one visible state:
//   recorded+routed, recorded-route-failed-retryable,
//   disabled/not-recorded, or terminal-failure.

import express, { type Express } from "express";
import { describe, expect, it } from "vitest";

import type { DbAdapter } from "../../src/db/db-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { migrateDecisionsTables } from "../../src/decisions/storage.js";
import { buildDeskNeedsMe } from "../../src/desk/needs-me.js";
import { ARTIFACT_COMMENT_DISPATCH_CHANNEL, type CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";

const ART = "art-comment-reliability";
const NOW = "2026-07-07T12:00:00.000Z";
const ON = { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv;

interface EnqueueCall {
  to_agent: string;
  from_actor: string;
  message: string;
  subject?: string;
  priority?: number;
  channel?: string;
}

function makeEnqueue(opts: { failFirst?: boolean; alwaysFail?: boolean } = {}): {
  fn: CommentDispatchEnqueueFn;
  calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  const fn: CommentDispatchEnqueueFn = async (input) => {
    calls.push(input);
    if (opts.alwaysFail || (opts.failFirst && calls.length === 1)) {
      throw new Error("route target unavailable");
    }
    return {
      query_id: `query-comment-${calls.length}`,
      dispatch_phid: `phid:disp-comment-${calls.length}`,
      status: "queued",
    };
  };
  return { fn, calls };
}

async function boot(enqueue?: CommentDispatchEnqueueFn, adapter: DbAdapter = new SqliteAdapter(":memory:")) {
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, { enqueueDispatch: enqueue, env: ON });
  return { app, adapter };
}

async function catalogArtifact(adapter: DbAdapter, agent: string): Promise<void> {
  await registerArtifact(
    adapter,
    {
      artifact_id: ART,
      basename: "comment-reliability.md",
      agent,
      abs_path: "/tmp/comment-reliability.md",
      title: "Comment reliability",
      produced_at: NOW,
      source: "manual",
      availability: "present",
    },
    NOW,
  );
}

async function call(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

class FailingCommentWriteAdapter implements DbAdapter {
  constructor(private readonly inner: DbAdapter) {}

  async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    if (/INSERT INTO artifact_operations/i.test(sql)) {
      throw new Error("comment write failed");
    }
    return this.inner.query<T>(sql, params);
  }

  exec(sql: string): void {
    return this.inner.exec(sql);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

describe("comment reliability acceptance states", () => {
  it("records and routes a successful comment, including feedback/timeline receipt", async () => {
    const { fn, calls } = makeEnqueue();
    const { app, adapter } = await boot(fn);
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "Please tighten the reliability wording.",
      anchor: "Acceptance bar",
    });

    expect(res.status).toBe(200);
    expect(res.body.visible_state).toBe("recorded+routed");
    expect(res.body.route_status).toMatchObject({
      visible_state: "recorded+routed",
      routed: true,
      retryable: false,
      target_agent: "regina",
      dispatch: { dispatch_phid: "phid:disp-comment-1", query_id: "query-comment-1" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      to_agent: "regina",
      from_actor: "user:chris",
      channel: ARTIFACT_COMMENT_DISPATCH_CHANNEL,
    });

    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments).toHaveLength(1);
    expect(comments.body.comments[0].route_status.visible_state).toBe("recorded+routed");

    const feedback = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(feedback.status).toBe(200);
    expect(feedback.body.acted_upon).toMatchObject({
      state: "routed",
      feedback_count: 1,
      routed_count: 1,
    });
    expect(feedback.body.items[0].routing).toMatchObject({
      dispatch_phid: "phid:disp-comment-1",
      query_id: "query-comment-1",
      to_agent: "regina",
    });
  });

  it("records project:<slug> target failures as retryable and reroutes the same comment on retry", async () => {
    const { fn, calls } = makeEnqueue({ failFirst: true });
    const { app, adapter } = await boot(fn);
    await catalogArtifact(adapter, "project:kapelle");

    const first = await call(
      app,
      "POST",
      `/artifacts/${ART}/comments`,
      {
        actor_ref: "user:liz",
        body: "Route this follow-up to the project owner.",
        idempotency_key: "comment-retry-1",
      },
      { "idempotency-key": "comment-retry-1" },
    );

    expect(first.status).toBe(200);
    expect(first.body.visible_state).toBe("recorded-route-failed-retryable");
    expect(first.body.feedback_status).toBe("recorded-route-failed-retryable");
    expect(first.body.route_status).toMatchObject({
      visible_state: "recorded-route-failed-retryable",
      feedback_status: "recorded-route-failed-retryable",
      routed: false,
      retryable: true,
      target_agent: "kapelle",
      target_agent_raw: "project:kapelle",
      error: { message: "route target unavailable" },
    });

    const retry = await call(
      app,
      "POST",
      `/artifacts/${ART}/comments`,
      {
        actor_ref: "user:liz",
        body: "Route this follow-up to the project owner.",
        idempotency_key: "comment-retry-1",
      },
      { "idempotency-key": "comment-retry-1" },
    );

    expect(retry.status).toBe(200);
    expect(retry.body.op_id).toBe(first.body.op_id);
    expect(retry.body.visible_state).toBe("recorded+routed");
    expect(retry.body.route_status).toMatchObject({
      visible_state: "recorded+routed",
      target_agent: "kapelle",
      target_agent_raw: "project:kapelle",
      dispatch: { dispatch_phid: "phid:disp-comment-2" },
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.to_agent)).toEqual(["kapelle", "kapelle"]);

    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.body.comments).toHaveLength(1);
    expect(comments.body.comments[0].op_id).toBe(first.body.op_id);
    expect(comments.body.comments[0].route_status.visible_state).toBe("recorded+routed");
  });

  it("returns not-recorded when durable comment persistence fails", async () => {
    const base = new SqliteAdapter(":memory:");
    await migrateSqlite(base);
    await migrateOutputsTables(base);
    const adapter = new FailingCommentWriteAdapter(base);
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, { enqueueDispatch: makeEnqueue().fn, env: ON });
    await catalogArtifact(adapter, "regina");

    const res = await call(app, "POST", `/artifacts/${ART}/comments`, {
      actor_ref: "user:chris",
      body: "This cannot be durably recorded.",
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      visible_state: "not-recorded",
      feedback_status: "disabled/not-recorded",
      error: "comment write failed",
    });

    const comments = await call(app, "GET", `/artifacts/${ART}/comments`);
    expect(comments.status).toBe(200);
    expect(comments.body.comments).toHaveLength(0);
  });

  it("excludes artifact-comment routed dispatches from the needs-you digest", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateDecisionsTables(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId("default");

    await insertDispatch(adapter, teamId, {
      dispatch_phid: "phid:disp-artifact-comment",
      query_id: "query_artifact_comment",
      channel: ARTIFACT_COMMENT_DISPATCH_CHANNEL,
      status: "failed",
      subject: "Artifact comment follow-up",
    });
    await insertDispatch(adapter, teamId, {
      dispatch_phid: "phid:disp-email",
      query_id: "query_email",
      channel: "email",
      status: "failed",
      subject: "Email follow-up",
    });

    const digest = await buildDeskNeedsMe(adapter, { generatedAt: NOW, teamName: "default" });

    expect(digest.counts.routed_items).toBe(1);
    expect(digest.items.map((item) => item.source_ref)).toEqual(["phid:disp-email"]);
  });
});

async function insertDispatch(
  adapter: DbAdapter,
  teamId: string,
  overrides: {
    dispatch_phid: string;
    query_id: string;
    channel: string;
    status: string;
    subject: string;
  },
) {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
      dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
      subject, body_markdown, provider, runtime, priority, status,
      not_before_at, attempt_count, bounce_count, last_bounce_json,
      bounce_history_json, started_at, completed_at, updated_at,
      agent_query_id, usage_policy_snapshot_json, failure_kind,
      failure_detail, target_url, result_json, clarification_id,
      active_clarification_json, clarification_history_json,
      resume_delivery_status, promote, promotion_strategy,
      promotion_required_reason, promotion_result_json, promotion_input_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      overrides.dispatch_phid,
      teamId,
      overrides.query_id,
      "regina",
      "user:chris",
      overrides.channel,
      overrides.subject,
      "Test body",
      "anthropic",
      "codex",
      5,
      overrides.status,
      NOW,
      0,
      0,
      null,
      "[]",
      null,
      overrides.status === "failed" ? NOW : null,
      NOW,
      null,
      null,
      overrides.status === "failed" ? "agent_error" : null,
      overrides.status === "failed" ? "seeded needs-operator failure" : null,
      null,
      null,
      null,
      null,
      "[]",
      "none",
      1,
      "auto",
      null,
      null,
      null,
    ],
  );
}
