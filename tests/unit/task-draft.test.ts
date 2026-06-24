// I-1 task doc-model — one creation schema for every source.
//
// Proves (1) buildTaskRow fills the canonical boilerplate identically for every
// source (id format, epoch-SECONDS timestamps, status derivation, track
// default), (2) each per-source adapter declares the right status/owner posture,
// and (3) a draft round-trips draft → TaskRow → TaskEntry so the creation schema
// and the read-model are one schema family.

import { describe, it, expect } from "vitest";
import {
  buildTaskRow,
  deriveTaskStatus,
  draftFromAutoAttach,
  draftFromDispatchApproval,
  draftFromManagerApi,
  draftFromScheduleDerived,
  draftFromTaskviewCli,
  UNASSIGNED_TRACK,
  type TaskDraft,
} from "../../src/tasks-readmodel/task-draft.js";
import { taskRowToEntry } from "../../src/tasks-readmodel/entry-projection.js";

const FIXED = { nowMs: 1_782_318_450_500, id: "task_fixed_1", uuid: "uuid-fixed-1" };

describe("buildTaskRow", () => {
  it("fills canonical boilerplate: id, uuid, epoch-SECONDS timestamps, null completed_at", () => {
    const row = buildTaskRow(draftFromManagerApi({ name: "x", team_id: "t1", title: "X" }), FIXED);
    expect(row.id).toBe("task_fixed_1");
    expect(row.uuid).toBe("uuid-fixed-1");
    expect(row.created_at).toBe(1_782_318_450); // ms floored to seconds
    expect(row.updated_at).toBe(1_782_318_450);
    expect(row.completed_at).toBeNull();
  });

  it("defaults a blank/absent track to '(unassigned)'", () => {
    expect(buildTaskRow(draftFromManagerApi({ name: "x", team_id: null, title: "X" })).track).toBe(UNASSIGNED_TRACK);
    expect(buildTaskRow(draftFromManagerApi({ name: "x", team_id: null, title: "X", track: "  " })).track).toBe(UNASSIGNED_TRACK);
    expect(buildTaskRow(draftFromManagerApi({ name: "x", team_id: null, title: "X", track: "T-CKPT" })).track).toBe("T-CKPT");
  });

  it("generates the canonical task_<ms>_<rand> id when none is injected", () => {
    const row = buildTaskRow(draftFromManagerApi({ name: "x", team_id: null, title: "X" }), { nowMs: 1700000000000 });
    expect(row.id).toMatch(/^task_1700000000000_[a-z0-9]+$/);
  });
});

describe("deriveTaskStatus", () => {
  it("honors an explicit status, else derives from owner", () => {
    expect(deriveTaskStatus({ source: "manager_api", name: "n", team_id: null, title: "T" })).toBe("todo");
    expect(deriveTaskStatus({ source: "manager_api", name: "n", team_id: null, title: "T", owner: "a1" })).toBe("doing");
    expect(deriveTaskStatus({ source: "auto_attach", name: "n", team_id: null, title: "T", status: "doing" })).toBe("doing");
  });
});

describe("per-source adapters preserve each source's posture", () => {
  it("manager_api: unowned ⇒ todo", () => {
    const row = buildTaskRow(draftFromManagerApi({ name: "n", team_id: "t", title: "T", created_by: "agent-roger" }));
    expect(row.status).toBe("todo");
    expect(row.owner).toBeNull();
    expect(row.created_by).toBe("agent-roger");
  });

  it("auto_attach: always owned ⇒ doing", () => {
    const row = buildTaskRow(draftFromAutoAttach({ name: "n", team_id: "t", title: "T", owner: "agent-x", created_by: "agent-y" }));
    expect(row.status).toBe("doing");
    expect(row.owner).toBe("agent-x");
  });

  it("schedule_derived: status follows owner presence", () => {
    expect(buildTaskRow(draftFromScheduleDerived({ name: "n", team_id: "t", title: "T" })).status).toBe("todo");
    expect(buildTaskRow(draftFromScheduleDerived({ name: "n", team_id: "t", title: "T", owner: "a" })).status).toBe("doing");
  });

  it("dispatch_approval: manager-owned (no creator), unowned, todo", () => {
    const row = buildTaskRow(draftFromDispatchApproval({ name: "approval-x", team_id: "t", title: "Approve X" }), FIXED);
    expect(row.status).toBe("todo");
    expect(row.created_by).toBeNull();
    expect(row.owner).toBeNull();
  });

  it("taskview_cli: maps a parsed to-do.md task", () => {
    const row = buildTaskRow(draftFromTaskviewCli({ name: "ship-thing", team_id: null, title: "Ship thing", owner: "agent-z", track: "T-SITE" }));
    expect(row.owner).toBe("agent-z");
    expect(row.status).toBe("doing");
    expect(row.track).toBe("T-SITE");
  });
});

describe("no cross-source drift: every source writes epoch-SECONDS + task_<ms> ids", () => {
  const drafts: TaskDraft[] = [
    draftFromManagerApi({ name: "a", team_id: "t", title: "A" }),
    draftFromAutoAttach({ name: "b", team_id: "t", title: "B", owner: "agent-x" }),
    draftFromScheduleDerived({ name: "c", team_id: "t", title: "C", owner: "agent-y" }),
    draftFromDispatchApproval({ name: "d", team_id: "t", title: "D" }),
    draftFromTaskviewCli({ name: "e", team_id: "t", title: "E" }),
  ];

  it("produces second-scale created_at for all sources (the approval ms-drift is gone)", () => {
    for (const draft of drafts) {
      const row = buildTaskRow(draft, { nowMs: 1_782_318_450_500 });
      expect(row.created_at).toBe(1_782_318_450);
      expect(row.created_at).toBeLessThan(1e12); // seconds, never ms
      expect(row.id).toMatch(/^task_\d+_[a-z0-9]+$/);
    }
  });
});

describe("round-trip: draft → TaskRow → TaskEntry are one schema family", () => {
  it("preserves identity, title, status, owner, and track through the read-model", () => {
    const draft = draftFromScheduleDerived({
      name: "audit-contracts-apr",
      team_id: "team_1",
      title: "Audit contracts (April)",
      description: "look at the Q2 contracts",
      owner: "agent-regina",
      created_by: "agent-roger",
      track: "T-CKPT",
    });
    const row = buildTaskRow(draft, FIXED);
    const entry = taskRowToEntry(row, new Map([["agent-regina", "regina"], ["agent-roger", "roger"]]));

    expect(entry.kind).toBe("task");
    expect(entry.phid).toBe(row.uuid);
    expect(entry.display_id).toBe("audit-contracts-apr");
    expect(entry.title).toBe("Audit contracts (April)");
    expect(entry.task_status).toBe("doing");
    expect(entry.body_markdown).toBe("look at the Q2 contracts");
    expect(entry.track).toBe("T-CKPT");
    expect(entry.owner).toEqual({ type: "agent", id: "regina" });
    // The read-model projects the same epoch-seconds timestamp the factory wrote.
    expect(entry.created_at).toBe("2026-06-24T16:27:30.000Z");
  });
});
