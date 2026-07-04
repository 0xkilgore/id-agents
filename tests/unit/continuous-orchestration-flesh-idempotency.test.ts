// Flesh / re-ingest idempotency + sticky routing (operator dispatch f4ce4782).
//
// Observed churn across 3 refuels: a flesh pass re-demoted promoted `ready` items
// back to needs_review and reset operator-set to_agent (often to roger/frontend-ui),
// undermining the ready-fuel floor and Claude-Light lane routing. These tests pin
// the two guards in recordFleshOutcome / listFleshCandidates:
//   (1) a flesh pass MUST NOT demote / mutate an item already at `ready` or beyond.
//   (2) a flesh pass MUST NOT overwrite an operator/human-set to_agent / priority.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  insertBacklogItem,
  getBacklogItem,
  updateBacklogFields,
  recordFleshOutcome,
  listFleshCandidates,
} from "../../src/continuous-orchestration/storage.js";
import type { FleshPatch } from "../../src/continuous-orchestration/types.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

function patch(over: Partial<FleshPatch> = {}): FleshPatch {
  return {
    to_agent: "roger",
    dispatch_body: "fleshed dispatch body",
    risk_class: "build",
    write_scope: ["src/x"],
    dependencies: [],
    token_estimate: 1000,
    provider: "anthropic",
    runtime: "claude",
    value_score: 50,
    priority: 9,
    confidence: 0.9,
    ready_decision: "auto_ready",
    reason: "auto",
    ...over,
  };
}

describe("recordFleshOutcome — idempotency guard (no demote at ready-or-beyond)", () => {
  it("leaves a promoted, operator-routed item completely unchanged on re-flesh", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-X — already promoted",
      readiness_state: "ready",
      to_agent: "finances",
      priority: 1,
      dispatch_body: "operator dispatch body",
    });

    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "needs_chris_batch",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ to_agent: "roger", priority: 9 }),
      promote: false,
    });

    // Returned + persisted row identical to the promoted original.
    expect(result?.readiness_state).toBe("ready");
    expect(result?.to_agent).toBe("finances");
    expect(result?.priority).toBe(1);
    expect(result?.flesh_attempts ?? 0).toBe(0); // no write happened at all

    const persisted = await getBacklogItem(adapter, created.item_id);
    expect(persisted?.readiness_state).toBe("ready");
    expect(persisted?.to_agent).toBe("finances");
    expect(persisted?.priority).toBe(1);
  });

  it("does not promote=true clobber an item already in_flight", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-Y — in flight",
      readiness_state: "in_flight",
      to_agent: "regina",
      priority: 2,
    });
    await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ to_agent: "roger" }),
      promote: true,
    });
    const persisted = await getBacklogItem(adapter, created.item_id);
    expect(persisted?.readiness_state).toBe("in_flight");
    expect(persisted?.to_agent).toBe("regina");
  });
});

describe("recordFleshOutcome — sticky routing guard (operator-set to_agent/priority)", () => {
  it("keeps an operator-set to_agent + priority while still fleshing + promoting", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-Z — operator routed, needs review",
      readiness_state: "needs_review",
    });
    // Operator explicitly routes the item (sets updated_by).
    await updateBacklogFields(adapter, created.item_id, { to_agent: "finances", priority: 3 }, { updated_by: "operator" });

    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ to_agent: "roger", priority: 9, dispatch_body: "auto body" }),
      promote: true,
    });

    expect(result?.to_agent).toBe("finances"); // sticky — NOT reset to roger
    expect(result?.priority).toBe(3); // sticky
    expect(result?.readiness_state).toBe("ready"); // still promoted
    expect(result?.dispatch_body).toBe("auto body"); // generated payload still filled
  });

  it("regression: a plain needs_review item (no operator routing) takes the flesher's to_agent/priority", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-W — unrouted needs review",
      readiness_state: "needs_review",
    });
    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ to_agent: "roger", priority: 9 }),
      promote: true,
    });
    expect(result?.to_agent).toBe("roger");
    expect(result?.priority).toBe(9);
    expect(result?.readiness_state).toBe("ready");
  });
});

describe("recordFleshOutcome — sticky dispatch_body guard (2026-07-04 clobber fix)", () => {
  it("does NOT overwrite an already-authored dispatch_body on an item still in needs_review (the promotion-race window)", async () => {
    // POST /orchestration/backlog forces every new item into draft/needs_review
    // regardless of the requested state — so a maestra/human-authored item with
    // a full dispatch_body can sit genuinely needs_review for a brief window
    // before the promote call lands. If a flesh tick fires in that window, it
    // was previously indistinguishable from a true empty skeleton.
    const created = await insertBacklogItem(adapter, {
      title: "T-CLOBBER — authored body, still needs_review",
      readiness_state: "needs_review",
      dispatch_body: "[project: kapelle] roger: the real, specific, human-authored task",
    });

    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.65,
      patch: patch({ dispatch_body: "generic templated dispatch body" }),
      promote: false,
    });

    expect(result?.dispatch_body).toBe("[project: kapelle] roger: the real, specific, human-authored task");
    const persisted = await getBacklogItem(adapter, created.item_id);
    expect(persisted?.dispatch_body).toBe("[project: kapelle] roger: the real, specific, human-authored task");
    // Everything else the flesh pass computes still lands — only dispatch_body is sticky.
    expect(persisted?.flesh_confidence).toBe(0.65);
    expect(persisted?.risk_class).toBe("build");
  });

  it("still flesh-fills dispatch_body normally on a true empty skeleton (no existing body)", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-SKELETON — unfleshed roadmap import",
      readiness_state: "needs_review",
      // no dispatch_body — a genuine unfleshed skeleton.
    });

    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ dispatch_body: "freshly generated dispatch body" }),
      promote: false,
    });

    expect(result?.dispatch_body).toBe("freshly generated dispatch body");
  });

  it("treats an empty-string dispatch_body the same as null — still flesh-eligible", async () => {
    const created = await insertBacklogItem(adapter, {
      title: "T-BLANK — blank string body",
      readiness_state: "draft",
      dispatch_body: "   ",
    });

    const result = await recordFleshOutcome(adapter, {
      item_id: created.item_id,
      flesh_status: "approved_ready",
      flesh_source: "roadmap",
      flesh_confidence: 0.9,
      patch: patch({ dispatch_body: "freshly generated dispatch body" }),
      promote: false,
    });

    expect(result?.dispatch_body).toBe("freshly generated dispatch body");
  });
});

describe("listFleshCandidates — never selects ready-or-beyond items, even when targeted by id", () => {
  it("excludes a ready item passed explicitly via item_ids", async () => {
    const ready = await insertBacklogItem(adapter, {
      title: "T-A — ready",
      readiness_state: "ready",
      to_agent: "finances",
    });
    const reviewable = await insertBacklogItem(adapter, {
      title: "T-B — needs review",
      readiness_state: "needs_review",
    });

    const candidates = await listFleshCandidates(adapter, {
      item_ids: [ready.item_id, reviewable.item_id],
    });
    const ids = candidates.map((c) => c.item_id);
    expect(ids).toContain(reviewable.item_id);
    expect(ids).not.toContain(ready.item_id);
  });
});
