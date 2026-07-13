// S4 (inbox-digest-manager-source) — manager-canonical artifact-comment source
// + dispatch reconciliation. The Cane inbox digest miscounted Chris's OWN routed
// feedback as "needs you" partly because it never reconciled a routed comment
// against the manager's live dispatch state. S4 adds an opt-in reconcile view:
// GET /artifacts/:id/feedback?reconcile=1 stamps each routing with its dispatch's
// LIVE status {status, effective_state, is_terminal} so the digest can show
// "routed to <owner> (dispatch <id>, status <…>)" and drop closed loops.
//
// Two layers under test:
//   - reconcileFeedbackDispatchStatus() — the pure join (resolver-agnostic).
//   - GET /artifacts/:id/feedback?reconcile=1 — the wired route + no-op defaults.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { reconcileFeedbackDispatchStatus } from "../../src/outputs/ops.js";
import type { CommentDispatchEnqueueFn } from "../../src/outputs/comment-dispatch.js";
import type {
  ActedUponSummary,
  ArtifactCommentRouteStatus,
  DispatchStatusLite,
  FeedbackItem,
  FeedbackRouting,
  TeamAwareDispatchStatusResolver,
} from "../../src/outputs/types.js";

const ART = "art-s4-1";
const ON = { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv;

// ── pure-helper fixtures ────────────────────────────────────────────
function routing(dispatch_phid: string, to_agent = "regina"): FeedbackRouting {
  return { dispatch_phid, query_id: null, to_agent, routed_at: "2026-06-29T00:00:00.000Z" };
}
function retryableRouteStatus(op_id: number): ArtifactCommentRouteStatus {
  return {
    visible_state: "recorded-route-failed-retryable",
    compat_status: "recorded-route-failed-retryable",
    feedback_status: "recorded-route-failed-retryable",
    route_kind: "substantive_follow_up",
    routed: false,
    retryable: true,
    recorded_op_id: op_id,
    target_agent: "regina",
    target_agent_raw: "regina",
    dispatch: null,
    skipped: "scheduler_unavailable",
    error: null,
    deadline_at: "2026-06-29T00:05:00.000Z",
    timed_out_at: null,
    notification_status: "pending",
    next_retry_at: "2026-06-29T00:05:00.000Z",
    suppress_duplicate_key: `artifact-comment:${op_id}:timeout`,
    updated_at: "2026-06-29T00:00:00.000Z",
  };
}

function commentItem(
  op_id: number,
  r: FeedbackRouting | null,
  route_status: ArtifactCommentRouteStatus | null = null,
): FeedbackItem {
  return {
    comment_id: `acmt:${ART}:${op_id}`,
    op_id,
    actor: "user:chris",
    kind: "comment",
    reaction: null,
    body: `comment ${op_id}`,
    anchor: null,
    ts: "2026-06-29T00:00:00.000Z",
    routing: r,
    route_status,
  };
}
function feedbackFixture(items: FeedbackItem[]): { items: FeedbackItem[]; acted_upon: ActedUponSummary } {
  const routed = items.map((i) => i.routing).filter((r): r is FeedbackRouting => r != null);
  const acted_upon: ActedUponSummary = {
    state: routed.length ? "routed" : items.length ? "captured" : "none",
    feedback_count: items.length,
    reaction_count: 0,
    routed_count: routed.length,
    last_reaction: null,
    last_feedback_at: items[0]?.ts ?? null,
    routed_dispatches: routed,
  };
  return { items, acted_upon };
}

// ── HTTP test harness (mirrors outputs-reactions-feedback.test.ts) ───
function makeFakeEnqueue(): { fn: CommentDispatchEnqueueFn; phids: string[] } {
  const phids: string[] = [];
  let n = 0;
  const fn: CommentDispatchEnqueueFn = async () => {
    n += 1;
    const dispatch_phid = `phid:disp-s4-${n}`;
    phids.push(dispatch_phid);
    return { query_id: `q-s4-${n}`, dispatch_phid, status: "queued" };
  };
  return { fn, phids };
}

async function buildApp(opts: {
  enqueue?: CommentDispatchEnqueueFn;
  resolveDispatchStatus?: TeamAwareDispatchStatusResolver;
} = {}): Promise<{ app: Express; adapter: SqliteAdapter }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(app, adapter, {
    enqueueDispatch: opts.enqueue,
    resolveDispatchStatus: opts.resolveDispatchStatus,
    env: ON,
  });
  return { app, adapter };
}

async function catalogArtifact(adapter: SqliteAdapter, agent: string): Promise<void> {
  await registerArtifact(
    adapter,
    {
      artifact_id: ART,
      basename: "s4-plan.md",
      agent,
      abs_path: "/Users/kilgore/Dropbox/Code/regina/output/s4-plan.md",
      title: "S4 plan",
      produced_at: new Date().toISOString(),
      source: "manual",
      availability: "present",
    },
    new Date().toISOString(),
  );
}

async function call(
  app: Express,
  method: "POST" | "GET",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

// Seed one Chris comment routed to an owning agent; returns its dispatch_phid.
async function seedRoutedComment(app: Express, adapter: SqliteAdapter): Promise<string> {
  await catalogArtifact(adapter, "regina");
  const res = await call(app, "POST", `/artifacts/${ART}/reactions`, {
    actor_ref: "user:chris",
    reaction: "iterate",
    note: "tighten the intro",
  });
  expect(res.status).toBe(200);
  expect(res.body.dispatch_routed).toBe(true);
  return res.body.dispatch.dispatch_phid as string;
}

describe("reconcileFeedbackDispatchStatus — pure dispatch join", () => {
  it("stamps live status onto item routings and the acted_upon rollup", async () => {
    const fb = feedbackFixture([commentItem(1, routing("phid:disp-A"))]);
    const resolve = async (phid: string): Promise<DispatchStatusLite | null> =>
      phid === "phid:disp-A"
        ? { status: "in_flight", effective_state: "in_flight", is_terminal: false }
        : null;

    const out = await reconcileFeedbackDispatchStatus(fb, resolve);

    expect(out.items[0].routing).toMatchObject({
      dispatch_phid: "phid:disp-A",
      status: "in_flight",
      effective_state: "in_flight",
      is_terminal: false,
    });
    // the rollup's routed_dispatches must carry the same enrichment (the digest
    // reads it from acted_upon)
    expect(out.acted_upon.routed_dispatches[0]).toMatchObject({
      dispatch_phid: "phid:disp-A",
      status: "in_flight",
      is_terminal: false,
    });
  });

  it("marks a done dispatch is_terminal so the digest can drop the closed loop", async () => {
    const fb = feedbackFixture([commentItem(1, routing("phid:disp-DONE"))]);
    const resolve = async (): Promise<DispatchStatusLite | null> => ({
      status: "done",
      effective_state: "done",
      is_terminal: true,
    });

    const out = await reconcileFeedbackDispatchStatus(fb, resolve);
    expect(out.items[0].routing?.status).toBe("done");
    expect(out.items[0].routing?.is_terminal).toBe(true);
    expect(out.items[0].routing?.work_success).toBe(true);
    expect(out.items[0].routing?.work_success_evidence).toBe("done");
    expect(out.items[0].routing?.work_success_blocker).toBeNull();
    expect(out.items[0].retry_readiness).toMatchObject({
      schema_version: "feedback.retry_readiness.v1",
      status: "stale_duplicate",
      retryable: false,
      stale_duplicate: true,
      next_action: "close_or_ignore",
      prior_dispatch_phid: "phid:disp-DONE",
      prior_dispatch_status: "done",
    });
  });

  it("projects retryable route failures separately from stale duplicate routed rows", async () => {
    const fb = feedbackFixture([
      commentItem(1, null, retryableRouteStatus(1)),
      commentItem(2, routing("phid:disp-DONE")),
    ]);
    const out = await reconcileFeedbackDispatchStatus(fb, async (phid) =>
      phid === "phid:disp-DONE"
        ? { status: "done", effective_state: "done", is_terminal: true }
        : null,
    );

    expect(out.items[0].retry_readiness).toMatchObject({
      status: "retryable_failed_row",
      retryable: true,
      stale_duplicate: false,
      next_action: "retry",
      route_visible_state: "recorded-route-failed-retryable",
      route_retryable: true,
    });
    expect(out.items[1].retry_readiness).toMatchObject({
      status: "stale_duplicate",
      retryable: false,
      stale_duplicate: true,
      next_action: "close_or_ignore",
      prior_dispatch_status: "done",
    });
  });

  it.each([
    ["acknowledgement-only manager closeout", "acknowledgement_only"],
    ["approval-FYI manager closeout", "approval_fyi_only"],
    ["linked-query expiry terminal record", "linked_query_expired"],
    ["empty-success output", "empty_success_candidate"],
  ])("does not stamp routed feedback as successful work for %s", async (_label, blocker) => {
    const fb = feedbackFixture([commentItem(1, routing("phid:disp-FALSE-SUCCESS"))]);
    const resolve = async (): Promise<DispatchStatusLite | null> => ({
      status: blocker === "linked_query_expired" ? "failed" : "done",
      effective_state: blocker === "linked_query_expired" ? "failed_needs_operator" : "needs_review",
      is_terminal: true,
      work_success: false,
      work_success_blocker: blocker,
    });

    const out = await reconcileFeedbackDispatchStatus(fb, resolve);

    expect(out.items[0].routing).toMatchObject({
      dispatch_phid: "phid:disp-FALSE-SUCCESS",
      is_terminal: true,
      work_success: false,
      work_success_evidence: null,
      work_success_blocker: blocker,
    });
    expect(out.acted_upon.routed_dispatches[0]).toMatchObject({
      work_success: false,
      work_success_blocker: blocker,
    });
  });

  it("leaves an unresolved (purged/unknown) dispatch status:null and treats it as live", async () => {
    const fb = feedbackFixture([commentItem(1, routing("phid:disp-GONE"))]);
    const resolve = async (): Promise<DispatchStatusLite | null> => null;

    const out = await reconcileFeedbackDispatchStatus(fb, resolve);
    expect(out.items[0].routing?.status).toBeNull();
    expect(out.items[0].routing?.is_terminal).toBe(false);
  });

  it("resolves each unique dispatch_phid exactly once (dedup across items)", async () => {
    const fb = feedbackFixture([
      commentItem(1, routing("phid:disp-X")),
      commentItem(2, routing("phid:disp-X")),
      commentItem(3, routing("phid:disp-Y")),
      commentItem(4, null), // un-routed comment: no lookup
    ]);
    const seen: string[] = [];
    const resolve = async (phid: string): Promise<DispatchStatusLite | null> => {
      seen.push(phid);
      return { status: "queued", effective_state: "queued", is_terminal: false };
    };

    await reconcileFeedbackDispatchStatus(fb, resolve);
    expect(seen.sort()).toEqual(["phid:disp-X", "phid:disp-Y"]);
  });

  it("leaves un-routed comments (routing:null) untouched", async () => {
    const fb = feedbackFixture([commentItem(1, null)]);
    const out = await reconcileFeedbackDispatchStatus(fb, async () => ({
      status: "done",
      effective_state: "done",
      is_terminal: true,
    }));
    expect(out.items[0].routing).toBeNull();
  });
});

describe("GET /artifacts/:id/feedback?reconcile=1 — wired reconciliation", () => {
  it("returns live dispatch status on the routing when reconcile is requested and a resolver is bound", async () => {
    const { fn } = makeFakeEnqueue();
    const resolveDispatchStatus: TeamAwareDispatchStatusResolver = async (phid) => ({
      status: "in_flight",
      effective_state: "in_flight",
      is_terminal: false,
    });
    const { app, adapter } = await buildApp({ enqueue: fn, resolveDispatchStatus });
    const phid = await seedRoutedComment(app, adapter);

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback?reconcile=1`);
    expect(fb.status).toBe(200);
    expect(fb.body.reconciled).toBe(true);
    expect(fb.body.items[0].routing).toMatchObject({
      dispatch_phid: phid,
      status: "in_flight",
      is_terminal: false,
    });
    expect(fb.body.items[0].retry_readiness).toMatchObject({
      schema_version: "feedback.retry_readiness.v1",
      status: "waiting_on_live_dispatch",
      retryable: false,
      stale_duplicate: false,
      next_action: "wait",
      prior_dispatch_phid: phid,
      prior_dispatch_status: "in_flight",
    });
    expect(fb.body.acted_upon.routed_dispatches[0].status).toBe("in_flight");
    expect(fb.body.acted_upon.routed_dispatches[0].work_success).toBeNull();
  });

  it("passes the routed dispatch_phid to the resolver so status reflects THAT dispatch", async () => {
    const { fn } = makeFakeEnqueue();
    const asked: string[] = [];
    const resolveDispatchStatus: TeamAwareDispatchStatusResolver = async (phid) => {
      asked.push(phid);
      return { status: "done", effective_state: "done", is_terminal: true };
    };
    const { app, adapter } = await buildApp({ enqueue: fn, resolveDispatchStatus });
    const phid = await seedRoutedComment(app, adapter);

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback?reconcile=1`);
    expect(asked).toContain(phid);
    expect(fb.body.items[0].routing.is_terminal).toBe(true);
    expect(fb.body.items[0].routing.work_success).toBe(true);
  });

  it.each([
    {
      label: "acknowledgement-only manager closeout",
      status: "done",
      effective_state: "needs_review",
      blocker: "acknowledgement_only",
    },
    {
      label: "approval-FYI manager closeout",
      status: "done",
      effective_state: "needs_review",
      blocker: "approval_fyi_only",
    },
    {
      label: "linked-query expiry terminal record",
      status: "failed",
      effective_state: "failed_needs_operator",
      blocker: "linked_query_expired",
    },
    {
      label: "empty-success output",
      status: "done",
      effective_state: "needs_review",
      blocker: "empty_success_candidate",
    },
  ])("does not report success from the feedback route when manager recorded $label", async (fixture) => {
    const { fn } = makeFakeEnqueue();
    const resolveDispatchStatus: TeamAwareDispatchStatusResolver = async () => ({
      status: fixture.status,
      effective_state: fixture.effective_state,
      is_terminal: true,
      work_success: false,
      work_success_blocker: fixture.blocker,
    });
    const { app, adapter } = await buildApp({ enqueue: fn, resolveDispatchStatus });
    await seedRoutedComment(app, adapter);

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback?reconcile=1`);

    expect(fb.status).toBe(200);
    expect(fb.body.acted_upon.state).toBe("routed");
    expect(fb.body.items[0].routing).toMatchObject({
      status: fixture.status,
      effective_state: fixture.effective_state,
      is_terminal: true,
      work_success: false,
      work_success_evidence: null,
      work_success_blocker: fixture.blocker,
    });
    expect(fb.body.acted_upon.routed_dispatches[0]).toMatchObject({
      work_success: false,
      work_success_blocker: fixture.blocker,
    });
  });

  it("is a no-op by default (no ?reconcile): routing carries no live status", async () => {
    const { fn } = makeFakeEnqueue();
    const resolveDispatchStatus: TeamAwareDispatchStatusResolver = async () => ({
      status: "in_flight",
      effective_state: "in_flight",
      is_terminal: false,
    });
    const { app, adapter } = await buildApp({ enqueue: fn, resolveDispatchStatus });
    await seedRoutedComment(app, adapter);

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback`);
    expect(fb.body.reconciled).toBe(false);
    expect(fb.body.items[0].routing.status).toBeUndefined();
  });

  it("degrades gracefully when reconcile is asked but no resolver is bound", async () => {
    const { fn } = makeFakeEnqueue();
    const { app, adapter } = await buildApp({ enqueue: fn }); // no resolver
    await seedRoutedComment(app, adapter);

    const fb = await call(app, "GET", `/artifacts/${ART}/feedback?reconcile=1`);
    expect(fb.status).toBe(200);
    expect(fb.body.reconciled).toBe(false);
    expect(fb.body.items[0].routing.status).toBeUndefined();
  });
});
