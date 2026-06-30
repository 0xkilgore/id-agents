// A1 — manager "needs-Chris decisions" projection (approvals cockpit scope).
// Contract: both kinds present in one typed list, server-authored allowed
// actions correct per kind, RD-001 stable ids. Parity: rows correspond 1:1 to
// the two underlying feeds, no invented/dropped rows.

import { describe, it, expect } from "vitest";
import {
  buildNeedsChrisQueue,
  type ClarificationInput,
  type BuildApprovalInput,
} from "../../src/decisions-needs-chris/projection.js";

const NOW = "2026-06-30T00:30:00.000Z";

function clar(over: Partial<ClarificationInput> = {}): ClarificationInput {
  return {
    dispatch_id: "phid:disp-abc",
    clarification_id: "clar_123",
    agent_id: "roger",
    subject: "Tasks status-hygiene scope",
    question: "Which repo: cane or id-agents?",
    urgency: "normal",
    stale_at: "2026-06-30T06:00:00.000Z",
    age_seconds: 600,
    ...over,
  };
}

function build(over: Partial<BuildApprovalInput> = {}): BuildApprovalInput {
  return {
    item_id: "coitem_xyz",
    title: "T-CKPT — approvals cockpit",
    to_agent: "frontend-ui-codex",
    risk_class: "build",
    priority: 3,
    created_at: "2026-06-30T00:20:00.000Z",
    ...over,
  };
}

describe("buildNeedsChrisQueue — contract", () => {
  it("returns both kinds as one typed list with correct counts", () => {
    const q = buildNeedsChrisQueue([clar()], [build(), build({ item_id: "coitem_2", priority: 1 })], NOW);
    expect(q.schema_version).toBe("decisions.needs-chris.v1");
    expect(q.generated_at).toBe(NOW);
    expect(q.counts).toEqual({ total: 3, clarification: 1, build_approval: 2 });
    expect(q.rows.map((r) => r.kind)).toEqual(["clarification", "build_approval", "build_approval"]);
  });

  it("clarification rows expose RD-001 stable id + answer/redirect/hold actions on /agent-resume", () => {
    const q = buildNeedsChrisQueue([clar()], [], NOW);
    const row = q.rows[0]!;
    expect(row.kind).toBe("clarification");
    expect(row.id).toBe("clar_123"); // clarification_id, not dispatch_id
    expect(row.dispatch_id).toBe("phid:disp-abc");
    expect(row.allowed_actions).toEqual(["approve", "re_route", "hold"]);
    const approve = row.actions.find((a) => a.action === "approve")!;
    expect(approve).toMatchObject({ method: "POST", path: "/agent-resume" });
    const hold = row.actions.find((a) => a.action === "hold")!;
    expect(hold).toMatchObject({ method: null, path: null });
    // never a build-only action
    expect(row.allowed_actions).not.toContain("reclassify");
  });

  it("falls back to dispatch_id as the stable id when clarification_id is null", () => {
    const q = buildNeedsChrisQueue([clar({ clarification_id: null })], [], NOW);
    expect(q.rows[0]!.id).toBe("phid:disp-abc");
  });

  it("build_approval rows expose item_id stable id + promote/re-route/reclassify/hold on the backlog endpoints", () => {
    const q = buildNeedsChrisQueue([], [build()], NOW);
    const row = q.rows[0]!;
    expect(row.kind).toBe("build_approval");
    expect(row.id).toBe("coitem_xyz");
    expect(row.dispatch_id).toBeNull();
    expect(row.agent).toBe("frontend-ui-codex");
    expect(row.allowed_actions).toEqual(["approve", "re_route", "reclassify", "hold"]);
    expect(row.actions.find((a) => a.action === "approve")).toMatchObject({
      method: "POST",
      path: "/orchestration/backlog/coitem_xyz/promote",
    });
    expect(row.actions.find((a) => a.action === "reclassify")).toMatchObject({
      method: "PATCH",
      path: "/orchestration/backlog/coitem_xyz",
    });
  });

  it("unassigned build item reports a sentinel agent, never empty/undefined", () => {
    const q = buildNeedsChrisQueue([], [build({ to_agent: null })], NOW);
    expect(q.rows[0]!.agent).toBe("(unassigned)");
  });

  it("derives urgency from build priority (1-2 high, 3-5 normal, 6+ low) and age from created_at", () => {
    const q = buildNeedsChrisQueue(
      [],
      [build({ item_id: "a", priority: 1 }), build({ item_id: "b", priority: 4 }), build({ item_id: "c", priority: 8 })],
      NOW,
    );
    const byId = Object.fromEntries(q.rows.map((r) => [r.id, r]));
    expect(byId["a"]!.urgency).toBe("high");
    expect(byId["b"]!.urgency).toBe("normal");
    expect(byId["c"]!.urgency).toBe("low");
    expect(byId["a"]!.age_seconds).toBe(600); // NOW - 00:20:00 = 10min
  });
});

describe("buildNeedsChrisQueue — parity with the two feeds", () => {
  it("emits exactly one row per input, no invented or dropped rows", () => {
    const clars = [clar({ clarification_id: "c1" }), clar({ clarification_id: "c2" })];
    const builds = [build({ item_id: "i1" }), build({ item_id: "i2" }), build({ item_id: "i3" })];
    const q = buildNeedsChrisQueue(clars, builds, NOW);
    expect(q.rows).toHaveLength(5);
    const clarIds = q.rows.filter((r) => r.kind === "clarification").map((r) => r.id).sort();
    expect(clarIds).toEqual(["c1", "c2"]);
    const buildIds = q.rows.filter((r) => r.kind === "build_approval").map((r) => r.id).sort();
    expect(buildIds).toEqual(["i1", "i2", "i3"]);
  });

  it("clarifications sort ahead of build approvals; builds ordered by priority", () => {
    const q = buildNeedsChrisQueue(
      [clar({ clarification_id: "c1" })],
      [build({ item_id: "lo", priority: 7 }), build({ item_id: "hi", priority: 1 })],
      NOW,
    );
    expect(q.rows.map((r) => r.id)).toEqual(["c1", "hi", "lo"]);
  });

  it("empty feeds → empty queue with zeroed counts", () => {
    const q = buildNeedsChrisQueue([], [], NOW);
    expect(q.rows).toEqual([]);
    expect(q.counts).toEqual({ total: 0, clarification: 0, build_approval: 0 });
  });
});
