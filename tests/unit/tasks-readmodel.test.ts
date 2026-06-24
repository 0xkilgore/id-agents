// I-1 doc-model proof-cut (Tasks step): the Desk/console must QUERY the tasks
// substrate (typed read-model) instead of walking to-do.md markdown. This
// mirrors the artifacts read-model (entry-projection + /artifacts/entries):
// a pure TaskEntry projection over the `tasks` table + a read-model.v1 envelope.

import { describe, it, expect } from "vitest";
import {
  taskRowToEntry,
  buildTasksEntriesEnvelope,
} from "../../src/tasks-readmodel/entry-projection.js";
import type { TaskRow } from "../../src/db/types.js";

const ROW: TaskRow = {
  id: "tsk_1",
  name: "audit-contracts-apr",
  uuid: "uuid-abc",
  team_id: "team_1",
  title: "Audit contracts (April)",
  description: "look at the Q2 contracts",
  status: "doing",
  created_by: "agent-roger",
  owner: "agent-regina",
  created_at: 1782318450, // epoch SECONDS
  updated_at: 1782319000,
  completed_at: null,
  track: "T-CKPT",
};

describe("taskRowToEntry", () => {
  it("projects a task row into the typed TaskEntry doc-model shape", () => {
    const names = new Map([["agent-roger", "roger"], ["agent-regina", "regina"]]);
    const e = taskRowToEntry(ROW, names);
    expect(e.phid).toBe("uuid-abc"); // stable cross-system id = uuid
    expect(e.kind).toBe("task");
    expect(e.schema_version).toBe(1);
    expect(e.display_id).toBe("audit-contracts-apr");
    expect(e.title).toBe("Audit contracts (April)");
    expect(e.task_status).toBe("doing");
    expect(e.body_markdown).toBe("look at the Q2 contracts");
    expect(e.owner).toEqual({ type: "agent", id: "regina" });
    expect(e.created_by).toEqual({ type: "agent", id: "roger" });
    expect(e.track).toBe("T-CKPT");
  });

  it("defaults track to '(unassigned)' when the row carries none", () => {
    const e = taskRowToEntry({ ...ROW, track: undefined as unknown as string }, new Map());
    expect(e.track).toBe("(unassigned)");
  });

  it("converts epoch-second timestamps to ISO, completed_at null when open", () => {
    const e = taskRowToEntry(ROW, new Map());
    expect(e.created_at).toBe("2026-06-24T16:27:30.000Z");
    expect(e.updated_at).toBe("2026-06-24T16:36:40.000Z");
    expect(e.completed_at).toBeNull();
  });

  it("handles millisecond epochs and a done task with completed_at", () => {
    const e = taskRowToEntry(
      { ...ROW, status: "done", completed_at: 1782319000000, created_at: 1782318450000 },
      new Map(),
    );
    expect(e.task_status).toBe("done");
    expect(e.created_at).toBe("2026-06-24T16:27:30.000Z");
    expect(e.completed_at).toBe("2026-06-24T16:36:40.000Z");
  });

  it("falls back to the raw owner id when no name is known, and system for no creator", () => {
    const e = taskRowToEntry({ ...ROW, created_by: null, owner: "agent-x" }, new Map());
    expect(e.owner).toEqual({ type: "agent", id: "agent-x" });
    expect(e.created_by).toEqual({ type: "system", id: "system" });
  });

  it("uses id as phid when uuid is empty", () => {
    expect(taskRowToEntry({ ...ROW, uuid: "" }, new Map()).phid).toBe("tsk_1");
  });
});

describe("buildTasksEntriesEnvelope", () => {
  const rows: TaskRow[] = [
    { ...ROW, id: "a", uuid: "a", updated_at: 300 },
    { ...ROW, id: "b", uuid: "b", updated_at: 100 },
    { ...ROW, id: "c", uuid: "c", updated_at: 200 },
  ];

  it("wraps entries in the shared read-model.v1 substrate envelope", () => {
    const env = buildTasksEntriesEnvelope(rows, new Map(), { limit: 50, offset: 0 });
    expect(env.schema_version).toBe("read-model.v1");
    expect(env.source).toEqual({ read_path: "substrate", projection: "task_entries" });
    expect(env.count).toBe(3);
    expect(env.limit).toBe(50);
    expect(env.items.every((i) => i.kind === "task")).toBe(true);
  });

  it("applies limit/offset to the (caller-ordered) rows", () => {
    const env = buildTasksEntriesEnvelope(rows, new Map(), { limit: 1, offset: 1 });
    expect(env.items.map((i) => i.phid)).toEqual(["b"]);
    expect(env.count).toBe(1);
    expect(env.offset).toBe(1);
  });
});
