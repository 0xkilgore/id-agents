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
    expect(q.counts).toMatchObject({ total: 2, clarification: 0, build_approval: 2, input_total: 3, excluded_total: 1 });
    expect(q.rows.map((r) => r.kind)).toEqual(["build_approval", "build_approval"]);
  });

  it("clarification rows expose RD-001 stable id + answer/redirect/hold actions on /agent-resume", () => {
    const q = buildNeedsChrisQueue([clar({ question: "Chris: approve the batch disposition?" })], [], NOW);
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
    const q = buildNeedsChrisQueue([clar({ clarification_id: null, question: "Chris: approve the batch disposition?" })], [], NOW);
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

describe("buildNeedsChrisQueue — operator queue filtering", () => {
  it("emits genuine decisions and accounts for every excluded input", () => {
    const clars = [
      clar({ clarification_id: "c1", question: "Chris: approve the batch disposition?" }),
      clar({ clarification_id: "c2", question: "Which repo: cane or id-agents?" }),
    ];
    const builds = [build({ item_id: "i1" }), build({ item_id: "i2" }), build({ item_id: "i3" })];
    const q = buildNeedsChrisQueue(clars, builds, NOW);
    expect(q.rows).toHaveLength(4);
    const clarIds = q.rows.filter((r) => r.kind === "clarification").map((r) => r.id).sort();
    expect(clarIds).toEqual(["c1"]);
    const buildIds = q.rows.filter((r) => r.kind === "build_approval").map((r) => r.id).sort();
    expect(buildIds).toEqual(["i1", "i2", "i3"]);
    expect(q.counts.input_total).toBe(5);
    expect(q.counts.excluded_total).toBe(1);
    expect(q.exclusions[0]).toMatchObject({ id: "c2", reason_code: "manager_agent_infrastructure", safety: "no_implicit_approval" });
  });

  it("clarifications sort ahead of build approvals; builds ordered by priority", () => {
    const q = buildNeedsChrisQueue(
      [clar({ clarification_id: "c1", question: "Chris: approve the batch disposition?" })],
      [build({ item_id: "lo", priority: 7 }), build({ item_id: "hi", priority: 1 })],
      NOW,
    );
    expect(q.rows.map((r) => r.id)).toEqual(["c1", "hi", "lo"]);
  });

  it("empty feeds → empty queue with zeroed counts", () => {
    const q = buildNeedsChrisQueue([], [], NOW);
    expect(q.rows).toEqual([]);
    expect(q.counts).toMatchObject({ total: 0, clarification: 0, build_approval: 0, input_total: 0, excluded_total: 0 });
  });

  it("classifies the current 29-row production shape and safely moots stale implementation questions", () => {
    const stale = "2026-06-29T00:00:00.000Z";
    const questions = [
      ...Array.from({ length: 5 }, (_, i) => `Please attach an in-app browser session ${i}`),
      ...Array.from({ length: 3 }, (_, i) => `Which canonical repo path should I use ${i}`),
      ...Array.from({ length: 7 }, (_, i) => `May I clean the dirty protected worktree ${i}`),
      ...Array.from({ length: 4 }, (_, i) => `Branch feature-${i} is ahead and behind main; which branch strategy?`),
      ...Array.from({ length: 6 }, (_, i) => `Which promotion strategy should I use for commit ${i}?`),
      "Which manager endpoint should record the receipt?",
      "Should I wait for the release candidate branch?",
      "Chris: approve the Wave133 batch disposition?",
      "Please enable Tailscale using the admin URL",
    ];
    expect(questions).toHaveLength(29);
    const q = buildNeedsChrisQueue(questions.map((question, i) => clar({
      dispatch_id: `phid:disp-${i}`,
      clarification_id: `clar_${i}`,
      question,
      stale_at: stale,
    })), [], NOW);

    expect(q.counts).toMatchObject({ input_total: 29, total: 2, clarification: 2, excluded_total: 27 });
    expect(q.counts.classified).toEqual({
      operator_judgment: 1,
      external_authorization: 1,
      manager_agent_resolvable: 2,
      stale_superseded: 25,
    });
    expect(q.exclusions.filter((e) => e.terminal_disposition === "moot")).toHaveLength(25);
    expect(q.exclusions.every((e) => e.safety === "no_implicit_approval")).toBe(true);
    expect(q.counts.excluded_by_reason).toMatchObject({
      stale_browser_request: 5,
      stale_path_question: 3,
      stale_worktree_question: 7,
      stale_branch_question: 4,
      stale_promotion_question: 6,
      manager_agent_infrastructure: 2,
    });
  });

  it("drops build rows that the approval policy explicitly classifies auto", () => {
    const q = buildNeedsChrisQueue([], [build({ item_id: "auto" }), build({ item_id: "gated" })], NOW, {
      classifyBuildApproval: (b) => ({ needs_chris: b.item_id === "gated", matched_rules: [], rationale: "fixture" }),
    });
    expect(q.rows.map((row) => row.id)).toEqual(["gated"]);
    expect(q.counts.excluded_by_reason).toEqual({ approval_policy_auto: 1 });
  });
});
