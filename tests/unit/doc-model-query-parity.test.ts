// T-QA.5 / PARITY — the I-1 doc-model query-layer cutover gate.
//
// Asserts the two substrate read paths faithfully represent their source of
// truth — the gate that must be green before any operator surface cuts over from
// the legacy read to the substrate query.
//
//  - ARTIFACTS: substrate projection vs the delivery-log.md MARKDOWN source, via
//    the real computeArtifactParity gate (every markdown row present + faithful
//    in the substrate; substrate MAY be a superset).
//  - TASKS: substrate query (buildTasksEntriesEnvelope → GET /tasks/entries) vs
//    the `tasks` rows. NOTE: tasks have no markdown read path yet — the
//    to-do.md → substrate ingestion is unwired ("taskview currently writes
//    markdown directly", task-draft.ts), so the tasks source of truth IS the
//    rows; this pins substrate↔row projection fidelity (presence, field
//    fidelity, ordering, pagination). When to-do.md ingestion lands, a
//    markdown-source parity mirroring the artifact gate should be added here.

import { describe, it, expect } from "vitest";
import { parseDeliveryLogRows, computeArtifactParity } from "../../src/outputs/parity.js";
import { buildTasksEntriesEnvelope } from "../../src/tasks-readmodel/entry-projection.js";
import type { TaskRow } from "../../src/db/types.js";

const NOW = "2026-06-25T12:00:00.000Z";

// ---- ARTIFACTS: substrate vs delivery-log.md markdown ----------------------

const LOG = [
  "# delivery log",
  "2026-06-25T10:00:00.000Z | roger | pipeline | a.md | /abs/a.md | \"Artifact A\"",
  "2026-06-24T09:00:00.000Z | regina | trinity | b.md | /abs/b.md | \"Artifact B\"",
].join("\n");

function comparable(over: { abs_path: string; agent: string | null; tag: string | null; title: string | null; produced_at: string }) {
  return over;
}

describe("artifacts substrate ↔ delivery-log.md parity gate", () => {
  it("is OK when the substrate faithfully contains every markdown row (superset allowed)", () => {
    const log = parseDeliveryLogRows(LOG);
    const substrate = [
      comparable({ abs_path: "/abs/a.md", agent: "roger", tag: "pipeline", title: "Artifact A", produced_at: "2026-06-25T10:00:00.000Z" }),
      comparable({ abs_path: "/abs/b.md", agent: "regina", tag: "trinity", title: "Artifact B", produced_at: "2026-06-24T09:00:00.000Z" }),
      // substrate-only row (filesystem/agent-done the walk never saw) — not drift.
      comparable({ abs_path: "/abs/c.md", agent: "cane", tag: null, title: "Artifact C", produced_at: "2026-06-23T08:00:00.000Z" }),
    ];
    const report = computeArtifactParity(substrate, log, NOW);
    expect(report.status).toBe("ok");
    expect(report.drift).toEqual([]);
  });

  it("DRIFTS when a markdown row is missing from the substrate (the cutover blocker)", () => {
    const log = parseDeliveryLogRows(LOG);
    const substrate = [
      comparable({ abs_path: "/abs/a.md", agent: "roger", tag: "pipeline", title: "Artifact A", produced_at: "2026-06-25T10:00:00.000Z" }),
      // /abs/b.md missing → drift
    ];
    const report = computeArtifactParity(substrate, log, NOW);
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("/abs/b.md"))).toBe(true);
  });

  it("DRIFTS when a title diverges between substrate and markdown", () => {
    const log = parseDeliveryLogRows(LOG);
    const substrate = [
      comparable({ abs_path: "/abs/a.md", agent: "roger", tag: "pipeline", title: "WRONG TITLE", produced_at: "2026-06-25T10:00:00.000Z" }),
      comparable({ abs_path: "/abs/b.md", agent: "regina", tag: "trinity", title: "Artifact B", produced_at: "2026-06-24T09:00:00.000Z" }),
    ];
    const report = computeArtifactParity(substrate, log, NOW);
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("title drift"))).toBe(true);
  });
});

// ---- TASKS: substrate query (GET /tasks/entries) ↔ tasks rows ---------------

function taskRow(over: Partial<TaskRow>): TaskRow {
  return {
    id: "t1",
    name: "do-thing",
    uuid: "uuid-1",
    team_id: "default",
    title: "Do the thing",
    description: "details",
    status: "todo",
    created_by: "chris",
    owner: null,
    created_at: 1_782_000_000,
    updated_at: 1_782_000_000,
    completed_at: null,
    track: "(unassigned)",
    ...over,
  };
}

describe("tasks substrate query ↔ rows projection fidelity gate", () => {
  it("projects every row, newest-first order preserved, with no rows dropped or added", () => {
    // Rows pre-ordered updated_at DESC (the route's order); envelope preserves it.
    const rows = [
      taskRow({ id: "t3", name: "c", updated_at: 1_782_000_300 }),
      taskRow({ id: "t2", name: "b", updated_at: 1_782_000_200 }),
      taskRow({ id: "t1", name: "a", updated_at: 1_782_000_100 }),
    ];
    const env = buildTasksEntriesEnvelope(rows, new Map(), { limit: 50, offset: 0 });
    expect(env.count).toBe(3);
    expect(env.items.map((e) => e.display_id)).toEqual(["c", "b", "a"]);
  });

  it("maps every field faithfully (status, title, track, owner, completion)", () => {
    const rows = [
      taskRow({
        id: "t9", name: "ship-x", uuid: "u9", title: "Ship X",
        status: "done", track: "T-QA", owner: "agent-uuid-7",
        completed_at: 1_782_000_500, updated_at: 1_782_000_500,
      }),
    ];
    const env = buildTasksEntriesEnvelope(rows, new Map([["agent-uuid-7", "roger"]]), { limit: 50, offset: 0 });
    const e = env.items[0];
    expect(e.display_id).toBe("ship-x");
    expect(e.title).toBe("Ship X");
    expect(e.task_status).toBe("done");
    expect(e.track).toBe("T-QA");
    expect(e.owner).toEqual({ type: "agent", id: "roger" }); // owner id resolved via agentNames
    expect(e.completed_at).toBe(new Date(1_782_000_500 * 1000).toISOString());
    expect(e.phid).toBe("u9"); // uuid preferred over id
  });

  it("paginates by limit/offset without dropping or duplicating rows across pages", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      taskRow({ id: `t${i}`, name: `task-${i}`, updated_at: 1_782_000_000 + (5 - i) }),
    );
    const page1 = buildTasksEntriesEnvelope(rows, new Map(), { limit: 2, offset: 0 });
    const page2 = buildTasksEntriesEnvelope(rows, new Map(), { limit: 2, offset: 2 });
    const page3 = buildTasksEntriesEnvelope(rows, new Map(), { limit: 2, offset: 4 });
    expect(page1.items.map((e) => e.display_id)).toEqual(["task-0", "task-1"]);
    expect(page2.items.map((e) => e.display_id)).toEqual(["task-2", "task-3"]);
    expect(page3.items.map((e) => e.display_id)).toEqual(["task-4"]);
    // union of pages == every row, once.
    const all = [...page1.items, ...page2.items, ...page3.items].map((e) => e.display_id);
    expect(new Set(all).size).toBe(5);
  });
});
