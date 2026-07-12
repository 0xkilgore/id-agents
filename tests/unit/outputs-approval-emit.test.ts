// Kapelle P3 (2026-06-09) — manager-side approval emit producer.
//
// When an operator approves a reviewed artifact via
// POST /artifacts/:id/approve, the manager creates a manager-visible
// task carrying the structured approval payload (artifact id, reviewer,
// approval state, source surface, timestamp). The task is the canonical
// downstream record; kapelle-site treats it as the truth.
//
// Idempotency: one task per artifact_id. Re-approve returns the existing
// task. The artifact_review_state's first-approve-wins semantics carry
// through.
//
// Failure handling: tasks_repository, validation, and team_resolution
// errors are returned as structured { kind, message, retry_with } so the
// caller can show the operator exactly how to retry.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { approveArtifact } from "../../src/outputs/ops.js";
import {
  emitApprovalTask,
  approvalTaskName,
  parseApprovalPayload,
  type ApprovalEmitInput,
} from "../../src/outputs/approval-emit.js";
import {
  summarizeTaskReconciliation,
  taskReconciliationFacts,
} from "../../src/task-reconciliation/currentness.js";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const tasks = new SqliteTasksRepo(adapter);
  const teamsRepo = new SqliteTeamsRepo(adapter);
  const teamId = await teamsRepo.getOrCreateTeamId("default");
  return { adapter, tasks, teamId };
}

function makeInput(teamId: string, overrides: Partial<ApprovalEmitInput> = {}): ApprovalEmitInput {
  return {
    artifact_id: "art:regina:2026-06-09-digest.md",
    reviewer: { kind: "human", id: "chris", label: "Chris" },
    approval_state: "approved",
    source_surface: "/ops/artifacts/art:regina:2026-06-09-digest.md",
    approved_at: "2026-06-09T14:00:00.000Z",
    op_id: 17,
    approval_note: null,
    team_id: teamId,
    ...overrides,
  };
}

describe("Kapelle P3 — approval emit producer", () => {
  it("derives a deterministic task name from the artifact id", () => {
    const a = approvalTaskName("art:regina:2026-06-09-digest.md");
    const b = approvalTaskName("art:regina:2026-06-09-digest.md");
    expect(a).toBe(b);
    expect(a).toMatch(/^artifact-approval-[a-f0-9]{12}$/);
    const c = approvalTaskName("art:regina:other.md");
    expect(c).not.toBe(a);
  });

  it("creates a task with all five required acceptance fields in the description payload", async () => {
    const { adapter, tasks, teamId } = await setup();
    const result = await emitApprovalTask({ adapter, tasks, input: makeInput(teamId) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idempotent).toBe(false);
    expect(result.task.name).toMatch(/^artifact-approval-[a-f0-9]{12}$/);
    expect(result.task.team_id).toBe(teamId);
    expect(result.task.status).toBe("todo");
    expect(result.task.owner).toBeNull();

    const payload = parseApprovalPayload(result.task.description ?? "");
    expect(payload).not.toBeNull();
    expect(payload?.artifact_id).toBe("art:regina:2026-06-09-digest.md");
    expect(payload?.reviewer.id).toBe("chris");
    expect(payload?.approval_state).toBe("approved");
    expect(payload?.source_surface).toBe(
      "/ops/artifacts/art:regina:2026-06-09-digest.md",
    );
    expect(payload?.approved_at).toBe("2026-06-09T14:00:00.000Z");
  });

  it("preserves real Chris approvals as open approval tasks", async () => {
    const { adapter, tasks, teamId } = await setup();
    const result = await emitApprovalTask({ adapter, tasks, input: makeInput(teamId) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("todo");
    expect(result.task.completed_at).toBeNull();

    const facts = taskReconciliationFacts(result.task, {
      today: "2026-06-09",
      nowEpochSeconds: Math.floor(new Date("2026-06-09T14:00:00.000Z").getTime() / 1000),
    });
    expect(facts.currentness).toMatchObject({
      state: "needs_chris",
      bucket: "needs_approval",
      needs_chris: true,
    });
  });

  it("closes non-Chris approval FYI tasks so they do not inflate needs_chris", async () => {
    const { adapter, tasks, teamId } = await setup();
    const result = await emitApprovalTask({
      adapter,
      tasks,
      input: makeInput(teamId, {
        artifact_id: "art:regina:liz-reviewed.md",
        reviewer: { kind: "human", id: "liz", label: "Liz" },
      }),
      now: () => new Date("2026-06-09T14:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("done");
    expect(result.task.completed_at).toBe(1781013600);

    const facts = taskReconciliationFacts(result.task, {
      today: "2026-06-09",
      nowEpochSeconds: 1781013600,
    });
    expect(facts.currentness).toMatchObject({
      state: "done",
      bucket: "done",
      needs_chris: false,
    });

    expect(summarizeTaskReconciliation([result.task], {
      today: "2026-06-09",
      nowEpochSeconds: 1781013600,
    })).toMatchObject({
      needs_approval: 0,
      done: 1,
    });
  });

  it("demotes an older open non-Chris approval FYI row on idempotent emit", async () => {
    const { adapter, tasks, teamId } = await setup();
    const input = makeInput(teamId, {
      artifact_id: "art:regina:old-liz-row.md",
      reviewer: { kind: "human", id: "liz", label: "Liz" },
    });
    const first = await emitApprovalTask({
      adapter,
      tasks,
      input,
      now: () => new Date("2026-06-09T14:00:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await tasks.updateFields(first.task.id, {
      status: "todo",
      completed_at: null,
      updated_at: first.task.updated_at + 1,
    });

    const second = await emitApprovalTask({
      adapter,
      tasks,
      input,
      now: () => new Date("2026-06-09T14:05:00.000Z"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotent).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.status).toBe("done");
    expect(second.task.completed_at).toBe(1781013900);
  });

  it("is idempotent — a second emit for the same artifact returns the existing task", async () => {
    const { adapter, tasks, teamId } = await setup();
    const first = await emitApprovalTask({ adapter, tasks, input: makeInput(teamId) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstTask = first.task;

    const second = await emitApprovalTask({
      adapter,
      tasks,
      input: makeInput(teamId, {
        approved_at: "2026-06-09T14:05:00.000Z",
        op_id: 18,
      }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotent).toBe(true);
    expect(second.task.id).toBe(firstTask.id);
    expect(second.task.name).toBe(firstTask.name);

    // No second row in the tasks table.
    const { rows } = await adapter.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM tasks WHERE name = ?",
      [firstTask.name],
    );
    expect(rows[0]?.c).toBe(1);
  });

  it("rejects invalid input shapes with kind='validation' and a retry_with hint", async () => {
    const { adapter, tasks, teamId } = await setup();
    const result = await emitApprovalTask({
      adapter,
      tasks,
      input: makeInput(teamId, { artifact_id: "" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validation");
    expect(result.error.retry_with).toBeDefined();
    expect(result.error.message.toLowerCase()).toContain("artifact_id");
  });

  it("returns kind='tasks_repository' with retry_with context when the repo throws", async () => {
    const { adapter, teamId } = await setup();
    const failingTasks = {
      create: async () => {
        throw new Error("disk write failed");
      },
      getByNameForTeam: async () => null,
    } as unknown as SqliteTasksRepo;

    const result = await emitApprovalTask({
      adapter,
      tasks: failingTasks,
      input: makeInput(teamId),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tasks_repository");
    expect(result.error.message).toContain("disk write failed");
    expect(result.error.retry_with?.method).toBe("POST");
    expect(result.error.retry_with?.url).toBe(
      "/artifacts/art:regina:2026-06-09-digest.md/approve",
    );
    expect(result.error.retry_with?.body).toEqual(
      expect.objectContaining({
        approver: "chris",
        source_surface: "/ops/artifacts/art:regina:2026-06-09-digest.md",
      }),
    );
  });

  it("ties the emitted task back to the originating approval operation by op_id", async () => {
    const { adapter, tasks, teamId } = await setup();
    // Run the real approveArtifact so op_id is real.
    const approve = await approveArtifact(adapter, "art:regina:2026-06-09-digest.md", {
      approver: "chris",
      note: "ship it",
    });
    const result = await emitApprovalTask({
      adapter,
      tasks,
      input: makeInput(teamId, {
        op_id: approve.op_id,
        approved_at: approve.state.approved_at ?? "",
        approval_note: approve.state.approval_note,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = parseApprovalPayload(result.task.description ?? "");
    expect(payload?.op_id).toBe(approve.op_id);
    expect(payload?.approval_note).toBe("ship it");
  });

  it("titles the task with the human-readable artifact id + reviewer", async () => {
    const { adapter, tasks, teamId } = await setup();
    const result = await emitApprovalTask({ adapter, tasks, input: makeInput(teamId) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.title).toContain("art:regina:2026-06-09-digest.md");
    expect(result.task.title.toLowerCase()).toContain("chris");
    expect(result.task.title.toLowerCase()).toContain("approved");
  });
});
