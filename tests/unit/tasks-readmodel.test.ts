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

describe("taskRowToEntry — DV2 provenance (I-1)", () => {
  const names = new Map([["agent-roger", "roger"], ["agent-regina", "regina"]]);

  it("carries the shared provenance contract (actor_ref, source dispatch, derived-from, chain)", () => {
    const e = taskRowToEntry(ROW, names);
    expect(e.source_dispatch_phid).toBeNull(); // reserved until tasks carry a dispatch link
    expect(e.links).toEqual([]);
    expect(e.provenance.source_dispatch_phid).toBeNull();
    expect(e.provenance.derived_from).toEqual([]);
    expect(Array.isArray(e.provenance.revisions)).toBe(true);
    expect(Array.isArray(e.provenance.contributors)).toBe(true);
  });

  it("builds a created→modified chain from the row timestamps + actors", () => {
    const e = taskRowToEntry(ROW, names); // updated_at != created_at, owner=regina
    expect(e.provenance.revisions).toEqual([
      { at: "2026-06-24T16:27:30.000Z", by: { type: "agent", id: "roger" }, note: "created" },
      { at: "2026-06-24T16:36:40.000Z", by: { type: "agent", id: "regina" }, note: "modified" },
    ]);
    expect(e.provenance.contributors).toEqual([
      { type: "agent", id: "roger" },
      { type: "agent", id: "regina" },
    ]);
  });

  it("collapses to a single 'created' revision when never modified", () => {
    const e = taskRowToEntry({ ...ROW, status: "todo", updated_at: ROW.created_at }, names);
    expect(e.provenance.revisions).toHaveLength(1);
    expect(e.provenance.revisions[0].note).toBe("created");
    expect(e.provenance.contributors).toEqual([{ type: "agent", id: "roger" }]);
  });

  it("labels the modifying revision 'completed' when that touch closed the task", () => {
    const e = taskRowToEntry({ ...ROW, status: "done", completed_at: ROW.updated_at }, names);
    expect(e.provenance.revisions.map((r) => r.note)).toEqual(["created", "completed"]);
  });

  it("emits a distinct 'completed' revision when completion happened later", () => {
    const e = taskRowToEntry(
      { ...ROW, status: "done", updated_at: 1782319000, completed_at: 1782319500 },
      names,
    );
    expect(e.provenance.revisions.map((r) => r.note)).toEqual(["created", "modified", "completed"]);
    // regina contributed twice (modified + completed) but appears once.
    expect(e.provenance.contributors).toEqual([
      { type: "agent", id: "roger" },
      { type: "agent", id: "regina" },
    ]);
  });

  it("attributes provenance to system when the creator is unknown", () => {
    const e = taskRowToEntry({ ...ROW, created_by: null, owner: null, updated_at: ROW.created_at }, names);
    expect(e.provenance.contributors).toEqual([{ type: "system", id: "system" }]);
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
