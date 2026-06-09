// Kapelle decisions queue structured-status — storage layer tests.
//
// The cto scope (2026-06-09-decision-queue-structured-status-scope.md) is
// explicit: status is a STRUCTURED column, never inferred from prose. The
// query for status=open MUST exclude any row whose stored status is
// resolved / superseded / declined regardless of what nearby markdown said.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  migrateDecisionsTables,
  insertDecision,
  appendDecisionEvent,
  listDecisions,
  getDecisionById,
  countDecisionsByStatus,
  findDecidedEventForDecision,
  recordDecideTransaction,
} from "../../src/decisions/storage.js";
import type { DecisionRow } from "../../src/decisions/types.js";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDecisionsTables(adapter);
  return adapter;
}

function makeDecision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decision_id: "dec_01",
    display_id: "#1",
    title: "Retract hosted-alpha door date?",
    question: "Formally retract the Mon 2026-06-16 hosted-alpha door date?",
    context_excerpt: null,
    recommendation_json: null,
    options_json: null,
    status: "open",
    estimated_seconds: 60,
    priority: "normal",
    owner: "chris",
    requested_by: "maestra",
    created_at: "2026-06-08T20:00:00.000Z",
    updated_at: "2026-06-08T20:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    selected_option_id: null,
    source_refs_json: JSON.stringify([]),
    provenance_json: JSON.stringify({}),
    ...overrides,
  };
}

describe("decisions storage migration", () => {
  it("creates decisions and decision_events tables with the CHECK constraint", async () => {
    const adapter = await setup();
    const { rows } = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('decisions', 'decision_events') ORDER BY name",
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(["decision_events", "decisions"]);
  });

  it("is idempotent — second migration call is a no-op", async () => {
    const adapter = await setup();
    await migrateDecisionsTables(adapter);
    await migrateDecisionsTables(adapter);
    const { rows } = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'",
      [],
    );
    expect(rows.length).toBe(1);
  });

  it("rejects an inserted row whose status is not one of the four valid values", async () => {
    const adapter = await setup();
    await expect(
      insertDecision(adapter, makeDecision({ status: "in_progress" as DecisionRow["status"] })),
    ).rejects.toThrow();
  });
});

describe("decisions storage — structured-status filter", () => {
  it("listDecisions(status='open') returns only rows whose stored status is open", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "dec_open_1", status: "open" }));
    await insertDecision(
      adapter,
      makeDecision({
        decision_id: "dec_resolved_1",
        status: "resolved",
        resolved_at: "2026-06-09T20:00:00.000Z",
        resolved_by: "human:chris",
      }),
    );
    await insertDecision(adapter, makeDecision({ decision_id: "dec_superseded_1", status: "superseded" }));
    await insertDecision(adapter, makeDecision({ decision_id: "dec_declined_1", status: "declined" }));

    const open = await listDecisions(adapter, { status: "open" });
    expect(open.map((d) => d.decision_id)).toEqual(["dec_open_1"]);

    const resolved = await listDecisions(adapter, { status: "resolved" });
    expect(resolved.map((d) => d.decision_id)).toEqual(["dec_resolved_1"]);
  });

  it("REGRESSION — inline RESOLVED markers cannot leak into status=open", async () => {
    // Cto scope's named test #1: fixture with prose containing an old open
    // question plus an inline resolved marker. The structured-status query
    // for status=open MUST exclude it. We simulate the bootstrap landing
    // by storing the row with status=resolved even though the original
    // question text reads as open.
    const adapter = await setup();
    await insertDecision(
      adapter,
      makeDecision({
        decision_id: "dec_inline_resolved",
        title:
          "Confirm B1 reassignment trigger Tue 2026-06-10 EOD if Roger silent. RESOLVED 2026-06-09 inline",
        question:
          "Confirm B1 reassignment trigger Tue 2026-06-10 EOD if Roger silent?",
        status: "resolved",
        resolved_at: "2026-06-09T22:00:00.000Z",
        resolved_by: "human:chris",
        resolution_note: "moot for this instance pending Roger/id-agents upstream promotion landing",
      }),
    );
    await insertDecision(adapter, makeDecision({ decision_id: "dec_a_truly_open", status: "open" }));

    const open = await listDecisions(adapter, { status: "open" });
    expect(open.map((d) => d.decision_id)).toEqual(["dec_a_truly_open"]);
  });

  it("REGRESSION — #42-#45 calendar records with appended resolved metadata do NOT appear for status=open", async () => {
    // Cto scope's named test #2: the actual incident. The four calendar
    // decisions originally carried open question text. After the batch
    // resolution, they carry appended `RESOLVED 2026-06-09 (Chris
    // approved)` markers. A correct importer marks the structured status
    // as resolved; status=open must return none of them.
    const adapter = await setup();
    const calendarRows = [
      {
        decision_id: "dec_42",
        display_id: "#42",
        title: "Add `Event` document model + typed Event ops to the Tier-1 task sweep proof case scope?",
        status: "resolved" as const,
        resolved_at: "2026-06-09T18:00:00.000Z",
      },
      {
        decision_id: "dec_43",
        display_id: "#43",
        title: "Adopt RFC 5545 `RRULE` as Kapelle's recurrence shape?",
        status: "resolved" as const,
        resolved_at: "2026-06-09T18:00:00.000Z",
      },
      {
        decision_id: "dec_44",
        display_id: "#44",
        title: "OP-9 (`/ops/calendar` view) as a new Tier-2 operator-productivity track slot?",
        status: "resolved" as const,
        resolved_at: "2026-06-09T18:00:00.000Z",
      },
      {
        decision_id: "dec_45",
        display_id: "#45",
        title: "Face B + Face C (external calendar sync) stay deferred?",
        status: "resolved" as const,
        resolved_at: "2026-06-09T18:00:00.000Z",
      },
    ];
    for (const r of calendarRows) await insertDecision(adapter, makeDecision(r));
    // Plus one genuinely open row added later — the queue should return exactly this one.
    await insertDecision(
      adapter,
      makeDecision({
        decision_id: "dec_56",
        display_id: "#56",
        title: "Confirm the next operator decision",
        status: "open",
      }),
    );

    const open = await listDecisions(adapter, { status: "open" });
    expect(open.map((d) => d.decision_id)).toEqual(["dec_56"]);
    expect(open.map((d) => d.display_id)).not.toContain("#42");
    expect(open.map((d) => d.display_id)).not.toContain("#43");
    expect(open.map((d) => d.display_id)).not.toContain("#44");
    expect(open.map((d) => d.display_id)).not.toContain("#45");
  });

  it("countDecisionsByStatus computes counts from the same structured store the queue reads", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "o1", status: "open" }));
    await insertDecision(adapter, makeDecision({ decision_id: "o2", status: "open" }));
    await insertDecision(adapter, makeDecision({ decision_id: "r1", status: "resolved" }));
    await insertDecision(adapter, makeDecision({ decision_id: "s1", status: "superseded" }));
    await insertDecision(adapter, makeDecision({ decision_id: "d1", status: "declined" }));

    expect(await countDecisionsByStatus(adapter, "open")).toBe(2);
    expect(await countDecisionsByStatus(adapter, "resolved")).toBe(1);
    expect(await countDecisionsByStatus(adapter, "superseded")).toBe(1);
    expect(await countDecisionsByStatus(adapter, "declined")).toBe(1);
  });
});

describe("decisions storage — decide transaction", () => {
  it("recordDecideTransaction updates status + resolved_at + resolved_by + selected_option_id AND appends event in one transaction", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "dec_to_decide", status: "open" }));

    const result = await recordDecideTransaction(adapter, {
      decision_id: "dec_to_decide",
      selected_option_id: "yes",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_to_decide:yes:human:chris",
      note_markdown: "ship it",
      now: "2026-06-09T22:00:00.000Z",
    });

    expect(result.kind).toBe("recorded");
    if (result.kind !== "recorded") return;

    const decision = await getDecisionById(adapter, "dec_to_decide");
    expect(decision?.status).toBe("resolved");
    expect(decision?.resolved_at).toBe("2026-06-09T22:00:00.000Z");
    expect(decision?.resolved_by).toBe("human:chris");
    expect(decision?.selected_option_id).toBe("yes");
    expect(decision?.resolution_note).toBe("ship it");

    const event = await findDecidedEventForDecision(adapter, "dec_to_decide");
    expect(event).not.toBeNull();
    expect(event?.event_type).toBe("decision.decided");
    expect(event?.actor).toBe("human:chris");
    const payload = JSON.parse(event?.payload_json ?? "{}");
    expect(payload.selected_option_id).toBe("yes");
    expect(payload.idempotency_key).toBe("decision:decide:v1:dec_to_decide:yes:human:chris");
  });

  it("returns kind='idempotent_replay' when the same idempotency_key is replayed", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "dec_idem", status: "open" }));
    const first = await recordDecideTransaction(adapter, {
      decision_id: "dec_idem",
      selected_option_id: "yes",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_idem:yes:human:chris",
      note_markdown: null,
      now: "2026-06-09T22:00:00.000Z",
    });
    expect(first.kind).toBe("recorded");

    const second = await recordDecideTransaction(adapter, {
      decision_id: "dec_idem",
      selected_option_id: "yes",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_idem:yes:human:chris",
      note_markdown: null,
      now: "2026-06-09T22:05:00.000Z",
    });
    expect(second.kind).toBe("idempotent_replay");
    if (second.kind !== "idempotent_replay") return;
    expect(second.existing_event.event_id).toBeTruthy();

    // Only one event row exists in total.
    const { rows } = await adapter.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM decision_events WHERE decision_id = ?",
      ["dec_idem"],
    );
    expect(rows[0]?.c).toBe(1);
  });

  it("returns kind='conflict' when the decision is already decided with a different option", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "dec_conflict", status: "open" }));
    await recordDecideTransaction(adapter, {
      decision_id: "dec_conflict",
      selected_option_id: "yes",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_conflict:yes:human:chris",
      note_markdown: null,
      now: "2026-06-09T22:00:00.000Z",
    });

    const conflict = await recordDecideTransaction(adapter, {
      decision_id: "dec_conflict",
      selected_option_id: "no",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_conflict:no:human:chris",
      note_markdown: null,
      now: "2026-06-09T22:10:00.000Z",
    });
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind !== "conflict") return;
    expect(conflict.existing_selected_option_id).toBe("yes");
  });

  it("returns kind='not_found' when the decision_id does not exist", async () => {
    const adapter = await setup();
    const result = await recordDecideTransaction(adapter, {
      decision_id: "dec_missing",
      selected_option_id: "yes",
      actor: "human:chris",
      idempotency_key: "decision:decide:v1:dec_missing:yes:human:chris",
      note_markdown: null,
      now: "2026-06-09T22:00:00.000Z",
    });
    expect(result.kind).toBe("not_found");
  });
});

describe("decisions storage — event log audit trail", () => {
  it("appendDecisionEvent stores the canonical lifecycle event for later replay/forensics", async () => {
    const adapter = await setup();
    await insertDecision(adapter, makeDecision({ decision_id: "dec_evlog" }));

    const eventId = await appendDecisionEvent(adapter, {
      decision_id: "dec_evlog",
      event_type: "decision.created",
      actor: "agent:maestra",
      created_at: "2026-06-08T20:00:00.000Z",
      payload_json: JSON.stringify({ source: "kapelle-decisions-queue.md" }),
    });
    expect(eventId).toBeTruthy();

    const { rows } = await adapter.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM decision_events WHERE decision_id = ?",
      ["dec_evlog"],
    );
    expect(rows[0]?.c).toBe(1);
  });
});
