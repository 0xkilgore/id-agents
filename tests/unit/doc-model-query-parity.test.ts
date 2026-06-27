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

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDeliveryLogRows, computeArtifactParity } from "../../src/outputs/parity.js";
import { buildTasksEntriesEnvelope } from "../../src/tasks-readmodel/entry-projection.js";
import type { TaskRow } from "../../src/db/types.js";
import { computeParity } from "../../src/substrate-migration/parity.js";
import type { ParityComparable } from "../../src/substrate-migration/types.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateInboxTables, listInboxItems } from "../../src/inbox/storage.js";
import { parseInboxMdLine, runFullProjection } from "../../src/inbox/projection.js";
import type { InboxItemRow } from "../../src/inbox/types.js";
import { useDocumentModel } from "../../src/config/feature-flags.js";
import {
  buildDeskEntriesEnvelope,
  deskRowToEntry,
} from "../../src/desk/entry-projection.js";
import {
  computeDeskDocModelParity,
  deskEntryToComparable,
  deskTrayItemToComparable,
} from "../../src/desk/doc-model-parity.js";
import { deskRowToTrayItem } from "../../src/desk/projection.js";
import { listDeskItems, migrateDeskTables, upsertDeskItem } from "../../src/desk/storage.js";

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

// ---- INBOX: doc-model query (inbox_items) ↔ intake SoT parity ---------------
//
// Sibling to the TASKS gate above, run through the SAME generic parity engine
// the ARTIFACTS gate uses (computeParity from the substrate-migration toolkit).
// The inbox doc-model substrate is the `inbox_items` table; its intake SoT is
// the two real write paths in src/inbox/projection.ts — structured shadow-JSON
// docs and the legacy inbox.md lines (the legacy-backfilled rows). This pins
// field-level parity between what the doc-model query SERVES (listInboxItems)
// and what the SoT implies:
//   - canonical id     → inbox_phid                  (ParityComparable.key)
//   - legacy_origin_id → origin_ref (shadow) ?? legacy inbox.md line (backfill)
//   - status           → operator_state
// INCLUDING the legacy-backfilled inbox.md rows. Unlike tasks (no markdown read
// path yet), inbox HAS one, so this exercises the real SoT→substrate projection
// end to end against an in-memory SqliteAdapter.

interface ShadowGlobalOverrides {
  origin_kind?: string;
  origin_ref?: string | null;
  received_at?: string;
  lifecycle_state?: string;
  assigned_agent?: string | null;
  dispatch_id?: string | null;
  done_at?: string | null;
  artifact_path?: string | null;
}

function shadowDoc(id: string, over: ShadowGlobalOverrides): string {
  return JSON.stringify({
    documentType: "kilgore/inbox-item",
    id,
    shadow: true,
    state: {
      global: {
        origin_kind: over.origin_kind ?? "email",
        origin_ref: over.origin_ref ?? null,
        received_at: over.received_at ?? "2026-05-27T12:00:00.000Z",
        received_by: "cane",
        lifecycle_state: over.lifecycle_state ?? "received",
        classification: "unknown",
        classification_reason: null,
        source_subject: null,
        source_from: null,
        source_text: "Body",
        source_excerpt: "Body",
        source_attachments: [],
        project_hint: null,
        priority_hint: null,
        triaged_at: null,
        triaged_by: null,
        claimed_at: null,
        claimed_by: null,
        assigned_agent: over.assigned_agent ?? null,
        dispatch_id: over.dispatch_id ?? null,
        query_id: null,
        started_at: null,
        done_at: over.done_at ?? null,
        artifact_path: over.artifact_path ?? null,
        artifact_tl_dr: null,
        shadow_refs: {},
        external_refs: {},
        last_error_code: null,
        last_error_message: null,
        last_error_at: null,
      },
    },
  });
}

// SoT-implied comparable: the canonical id, legacy origin, and status the intake
// SoT demands for a row — asserted against the projection, not read back from it.
function inboxSot(key: string, ordering_ts: string, legacy_origin_id: string, status: string): ParityComparable {
  return { key, ordering_ts, fidelity: { legacy_origin_id, status } };
}

// The doc-model query row reduced to the same comparable shape (the read side).
function inboxServedToComparable(row: InboxItemRow): ParityComparable {
  return {
    key: row.inbox_phid,
    ordering_ts: row.received_at,
    fidelity: {
      legacy_origin_id: row.origin_ref ?? row.legacy_inbox_md_line,
      status: row.operator_state,
    },
  };
}

// The two legacy-backfilled inbox.md lines, kept as constants so the expected
// legacy_origin_id is byte-identical to what projectInboxMd stores.
const MD_DONE = "- [x] [2026-05-27 10:00] [email] #task — Backfilled done item → done";
const MD_OPEN = "- [ ] [2026-05-27 09:00] [telegram] #note — Backfilled open item";

function mdPhid(line: string): string {
  return `inbox-md-${parseInboxMdLine(line)!.lineHash}`;
}

describe("inbox doc-model query (inbox_items) ↔ intake SoT parity gate", () => {
  let adapter: SqliteAdapter;
  let shadowDir: string;
  let mdPath: string;

  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    migrateInboxTables(adapter);

    const root = mkdtempSync(join(tmpdir(), "inbox-docmodel-parity-"));
    shadowDir = join(root, "shadow");
    mkdirSync(shadowDir);
    mdPath = join(root, "inbox.md");

    // SoT — structured shadow intake: one 'received' (→ new), one dispatch-linked
    // (→ waiting_on_agent).
    writeFileSync(
      join(shadowDir, "new.json"),
      shadowDoc("shadow-new-1", { origin_ref: "cane:new-1", received_at: "2026-05-27T12:00:00.000Z" }),
    );
    writeFileSync(
      join(shadowDir, "disp.json"),
      shadowDoc("shadow-disp-1", {
        origin_ref: "cane:disp-1",
        received_at: "2026-05-27T11:00:00.000Z",
        assigned_agent: "finances",
        dispatch_id: "disp-x",
      }),
    );

    // SoT — legacy inbox.md backfill: one checked (→ checked_off), one open (→ new).
    writeFileSync(mdPath, `# Inbox\n${MD_DONE}\n${MD_OPEN}\n`);

    await runFullProjection(adapter, shadowDir, mdPath);
  });

  // The SoT-implied population, newest-first. Status values are the intake
  // semantics, asserted against the projection (not re-derived from it).
  function sotPopulation(): ParityComparable[] {
    return [
      inboxSot("shadow-new-1", "2026-05-27T12:00:00.000Z", "cane:new-1", "new"),
      inboxSot("shadow-disp-1", "2026-05-27T11:00:00.000Z", "cane:disp-1", "waiting_on_agent"),
      inboxSot(mdPhid(MD_DONE), "2026-05-27T10:00:00.000Z", MD_DONE, "checked_off"),
      inboxSot(mdPhid(MD_OPEN), "2026-05-27T09:00:00.000Z", MD_OPEN, "new"),
    ];
  }

  it("serves every SoT row with faithful canonical id, legacy_origin_id, and status — including legacy-backfilled inbox.md rows", async () => {
    const served = await listInboxItems(adapter, {}, 100, 0);
    const report = computeParity(served.map(inboxServedToComparable), sotPopulation(), NOW);

    expect(report.status).toBe("ok");
    expect(report.drift).toEqual([]);
    expect(report.legacy_count).toBe(4);
    expect(report.substrate_count).toBe(4);

    // Explicitly pin the legacy-backfilled rows (the inbox.md path).
    const byId = new Map(served.map((r) => [r.inbox_phid, r]));
    const done = byId.get(mdPhid(MD_DONE));
    const open = byId.get(mdPhid(MD_OPEN));
    expect(done?.operator_state).toBe("checked_off");
    expect(done?.legacy_inbox_md_line).toBe(MD_DONE);
    expect(open?.operator_state).toBe("new");
    expect(open?.legacy_inbox_md_line).toBe(MD_OPEN);
  });

  it("DRIFTS when a served row's status diverges from the SoT (the cutover blocker)", async () => {
    // Corrupt the doc-model read: flip the backfilled checked_off row to 'new'.
    await adapter.query("UPDATE inbox_items SET operator_state = $1 WHERE inbox_phid = $2", [
      "new",
      mdPhid(MD_DONE),
    ]);
    const served = await listInboxItems(adapter, {}, 100, 0);
    const report = computeParity(served.map(inboxServedToComparable), sotPopulation(), NOW);

    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("status drift") && d.includes(mdPhid(MD_DONE)))).toBe(true);
  });

  it("DRIFTS when a SoT row is missing from the doc-model read", async () => {
    await adapter.query("DELETE FROM inbox_items WHERE inbox_phid = $1", [mdPhid(MD_OPEN)]);
    const served = await listInboxItems(adapter, {}, 100, 0);
    const report = computeParity(served.map(inboxServedToComparable), sotPopulation(), NOW);

    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("missing in substrate") && d.includes(mdPhid(MD_OPEN)))).toBe(true);
  });
});

describe("desk doc-model query ↔ current tray projection parity gate", () => {
  it("DESK_USE_DOCUMENT_MODEL defaults OFF (cutover not flipped)", () => {
    expect(useDocumentModel("desk", {})).toBe(false);
    expect(useDocumentModel("desk", { DESK_USE_DOCUMENT_MODEL: "false" })).toBe(false);
  });

  it("substrate entries match current tray items for a sample set of on_desk rows", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDeskTables(adapter);
    await upsertDeskItem(adapter, {
      label: "Review Wave 4 closeout",
      kind: "artifact",
      source_ref: "art_wave4",
      tray_zone: "needs_you",
      added_at: "2026-06-25T10:00:00.000Z",
    });
    await upsertDeskItem(adapter, {
      label: "Shipped report",
      kind: "note",
      tray_zone: "shipped",
      added_at: "2026-06-24T09:00:00.000Z",
    });

    const deskRows = await listDeskItems(adapter, { desk_class: "tray", tray_state: "on_desk", limit: 50 });
    const opsByItemId = new Map<string, never[]>();
    const substrateEntries = deskRows.map((row) => deskRowToEntry(row, opsByItemId.get(row.desk_item_id) ?? []));
    const currentTrayItems = deskRows.map(deskRowToTrayItem);

    const report = computeDeskDocModelParity(substrateEntries, currentTrayItems, NOW);
    expect(report.status).toBe("ok");
    expect(report.drift).toEqual([]);

    const envelope = buildDeskEntriesEnvelope(deskRows, opsByItemId, { limit: 50, offset: 0 }, report.status);
    expect(envelope.schema_version).toBe("read-model.v1");
    expect(envelope.source).toEqual({ read_path: "substrate", projection: "desk_entries" });
    expect(envelope.items).toHaveLength(2);
    expect(envelope.items.map((e) => e.title)).toEqual(["Review Wave 4 closeout", "Shipped report"]);
  });

  it("DRIFTS when a tray projection title diverges from the substrate entry (cutover blocker)", () => {
    const rowKey = "desk_sample_1";
    const substrate = [
      deskEntryToComparable({
        phid: rowKey,
        kind: "desk_item",
        schema_version: 1,
        display_id: rowKey,
        title: "Substrate title",
        body_markdown: "",
        desk_item_kind: "note",
        tray_zone: "needs_you",
        tray_state: "on_desk",
        source_ref: null,
        created_at: NOW,
        created_by: { type: "system", id: "system" },
        updated_at: NOW,
        updated_by: { type: "system", id: "system" },
        provenance: {
          actor_ref: { type: "system", id: "system" },
          source: null,
          origin: "substrate",
          source_dispatch_phid: null,
          derived_from: [],
          revisions: [],
          contributors: [],
        },
      }),
    ];
    const legacy = [
      deskTrayItemToComparable({
        desk_item_id: rowKey,
        label: "Legacy tray label",
        kind: "note",
        desk_class: "tray",
        tray_zone: "needs_you",
        body_md: "",
        source_ref: null,
        added_at: NOW,
        added_by: "system",
        tray_state: "on_desk",
        dismissed_at: null,
        provenance: { source_path: null, anchor: null, parser_version: "desk.tray.v1" },
        href: null,
        priority: null,
      }),
    ];
    const report = computeParity(substrate, legacy, NOW);
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("title drift"))).toBe(true);
  });
});
