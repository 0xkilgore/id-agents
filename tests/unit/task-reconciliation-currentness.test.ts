import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../src/db/types.js";
import {
  compactTaskTitle,
  summarizeTaskReconciliation,
  taskReconciliationFacts,
} from "../../src/task-reconciliation/currentness.js";

const ROW: TaskRow = {
  id: "tsk_1",
  name: "follow-up-with-very-long-work",
  uuid: "uuid-1",
  team_id: "default",
  title: "Follow up with the architecture reviewer about the unusually long stale task title that used to dominate the lane",
  description: null,
  status: "todo",
  created_by: "maestra",
  owner: "roger",
  created_at: 1782318450,
  updated_at: 1782319000,
  completed_at: null,
  track: "(unassigned)",
};

function approvalDescription(overrides: Record<string, unknown> = {}): string {
  return [
    "# Approval-emitted task",
    "",
    "```json",
    JSON.stringify(
      {
        schema_version: "artifact.approval.v1",
        artifact_id: "art-approval-fyi",
        reviewer: { kind: "human", id: "chris", label: "Chris" },
        approval_state: "approved",
        source_surface: "/ops/artifacts/art-approval-fyi",
        approved_at: "2026-07-08T14:00:00.000Z",
        op_id: 42,
        approval_note: null,
        ...overrides,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

describe("task reconciliation currentness", () => {
  it("compacts display titles to <=90 chars while retaining the full title in audit", () => {
    const title = compactTaskTitle(ROW.title);

    expect(title.display_title.length).toBeLessThanOrEqual(90);
    expect(title.display_title).toMatch(/\.\.\.$/);
    expect(title.full_title).toBe(ROW.title);
    expect(title.compacted).toBe(true);
  });

  it("marks past-due open tasks as stale and approval-routed", () => {
    const facts = taskReconciliationFacts(
      { ...ROW, title: "Past due thing due:2026-07-01" },
      { today: "2026-07-08", nowEpochSeconds: 1783523200 },
    );

    expect(facts.currentness).toMatchObject({
      state: "stale",
      bucket: "stale",
      urgency: "now",
      stale: true,
      stale_reason: "past_due",
      needs_chris: true,
      proposed_action: "review_stale",
    });
  });

  it("routes unowned open tasks to Needs Chris without mutating them", () => {
    const facts = taskReconciliationFacts(
      { ...ROW, owner: null, title: "Assign owner due:2026-07-09" },
      { today: "2026-07-08", nowEpochSeconds: 1783523200 },
    );

    expect(facts.currentness).toMatchObject({
      state: "needs_chris",
      bucket: "needs_approval",
      stale: false,
      proposed_action: "assign_owner",
    });
  });

  it("demotes approval-emitted FYI rows so they do not inflate Needs Chris", () => {
    const facts = taskReconciliationFacts(
      {
        ...ROW,
        name: "artifact-approval-123456abcdef",
        title: "Artifact approved: art-approval-fyi by Chris",
        description: approvalDescription(),
        owner: null,
      },
      { today: "2026-07-08", nowEpochSeconds: 1783523200 },
    );

    expect(facts.currentness).toMatchObject({
      state: "current",
      bucket: "duplicate_or_noop",
      urgency: "none",
      stale: false,
      needs_chris: false,
      proposed_action: "none",
    });
    expect(facts.currentness.evidence).toContain(
      "approval-emitted FYI task with canonical artifact.approval.v1 payload",
    );
  });

  it("preserves unowned approval-looking rows without the canonical payload as real owner asks", () => {
    const facts = taskReconciliationFacts(
      {
        ...ROW,
        name: "artifact-approval-123456abcdef",
        title: "Approval needed for follow-up artifact",
        description: "Please review this real approval request.",
        owner: null,
      },
      { today: "2026-07-08", nowEpochSeconds: 1783523200 },
    );

    expect(facts.currentness).toMatchObject({
      state: "needs_chris",
      bucket: "needs_approval",
      needs_chris: true,
      proposed_action: "assign_owner",
    });
  });

  it("preserves claimed approval tasks as normal actionable work", () => {
    const facts = taskReconciliationFacts(
      {
        ...ROW,
        name: "artifact-approval-123456abcdef",
        title: "Artifact approved: art-approval-fyi by Chris",
        description: approvalDescription(),
        owner: "roger",
      },
      { today: "2026-07-08", nowEpochSeconds: 1783523200 },
    );

    expect(facts.currentness).toMatchObject({
      state: "current",
      bucket: "actionable_ready",
      needs_chris: false,
      proposed_action: "none",
    });
  });

  it("marks stale doing tasks as blocked_or_failed", () => {
    const facts = taskReconciliationFacts(
      { ...ROW, status: "doing", updated_at: 1782319000 },
      { today: "2026-07-08", nowEpochSeconds: 1783523200, staleAfterDays: 7 },
    );

    expect(facts.currentness).toMatchObject({
      state: "blocked",
      bucket: "blocked_or_failed",
      stale_reason: "doing_stale",
      proposed_action: "resume_or_close",
    });
  });

  it("summarizes parity buckets deterministically across reruns", () => {
    const rows: TaskRow[] = [
      { ...ROW, id: "ready", name: "ready", title: "Ready due:2026-07-09", updated_at: 1783523000 },
      { ...ROW, id: "stale", name: "stale", title: "Past due due:2026-07-01" },
      { ...ROW, id: "approval", name: "approval", owner: null, title: "Needs owner" },
      {
        ...ROW,
        id: "approval-fyi",
        name: "artifact-approval-123456abcdef",
        owner: null,
        title: "Artifact approved: art-approval-fyi by Chris",
        description: approvalDescription(),
      },
      { ...ROW, id: "blocked", name: "blocked", status: "doing", updated_at: 1782319000 },
      { ...ROW, id: "done", name: "done", status: "done", completed_at: 1783523000 },
    ];
    const opts = { today: "2026-07-08", nowEpochSeconds: 1783523200, staleAfterDays: 7 };

    expect(summarizeTaskReconciliation(rows, opts)).toEqual(summarizeTaskReconciliation(rows, opts));
    expect(summarizeTaskReconciliation(rows, opts)).toMatchObject({
      actionable_ready: 1,
      needs_approval: 1,
      stale: 1,
      blocked_or_failed: 1,
      done: 1,
      duplicate_or_noop: 1,
    });
  });
});
