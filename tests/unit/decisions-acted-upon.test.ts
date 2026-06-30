// P5: acted-upon read model + typed decision actions — route tests.
//
// Contract: cto/output/2026-06-19-kapelle-pdf-ux-backend-contracts.md §P5.
// Verifies the acted-upon state is DERIVED from the decision row + the
// append-only decision_events log, the typed action append path is
// idempotent, conflicts return 409, and migrated-markdown provenance
// surfaces a parser warning.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { insertDecision, listDecisionEvents, migrateDecisionsTables } from "../../src/decisions/storage.js";
import { mountDecisionsRoutes } from "../../src/decisions/routes.js";
import type { DecisionRow } from "../../src/decisions/types.js";

function makeRow(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decision_id: "dec_1",
    display_id: "#1",
    title: "Title",
    question: "Question?",
    context_excerpt: null,
    recommendation_json: null,
    options_json: JSON.stringify([{ option_id: "opt_a", label: "A", value: "a", recommended: true, effect_summary: "" }]),
    status: "open",
    estimated_seconds: 60,
    priority: "normal",
    owner: "chris",
    requested_by: "maestra",
    created_at: "2026-06-19T20:00:00.000Z",
    updated_at: "2026-06-19T20:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    selected_option_id: null,
    source_refs_json: JSON.stringify([]),
    provenance_json: JSON.stringify({}),
    ...overrides,
  };
}

async function bootApp() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDecisionsTables(adapter);
  const app = express();
  app.use(express.json());
  mountDecisionsRoutes(app, adapter, { now: () => new Date("2026-06-19T22:00:00.000Z") });
  return { app, adapter };
}

function client(app: Express) {
  const run = (method: "GET" | "POST", path: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", async () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("no address"));
        try {
          const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
            method,
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
          });
          const text = await r.text();
          let parsed: any;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          server.close(() => resolve({ status: r.status, body: parsed }));
        } catch (e) {
          server.close(() => reject(e));
        }
      });
    });
  return {
    get: (p: string) => run("GET", p),
    post: (p: string, b?: unknown) => run("POST", p, b),
  };
}

const decide = (option = "opt_a", key = "decide-1") => ({
  actor: "human:chris",
  selected_option_id: option,
  idempotency_key: key,
});

describe("P5 acted-upon read model", () => {
  it("returns 404 for an unknown decision", async () => {
    const { app } = await bootApp();
    const res = await client(app).get("/decisions/nope/acted-upon");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("decision_not_found");
  });

  it("returns not_acted for an open decision", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    const res = await client(app).get("/decisions/dec_1/acted-upon");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("decision.acted-upon.v1");
    expect(res.body.state).toBe("not_acted");
    expect(res.body.selected_option_id).toBeNull();
    expect(res.body.acted_at).toBeNull();
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0]).toMatchObject({
      operation_type: "DECISION_VIEWED",
      actor: { kind: "human", id: "chris", ref: "human:chris" },
      idempotency_key: "decision:viewed:v1:dec_1:human:chris",
    });
  });

  it("marks the decision read when the acted-upon detail is viewed, idempotently", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    const first = await client(app).get("/decisions/dec_1/acted-upon");
    const second = await client(app).get("/decisions/dec_1/acted-upon");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const events = await listDecisionEvents(adapter, "dec_1");
    const viewed = events.filter((event) => event.event_type === "decision.viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]!.actor).toBe("human:chris");
    expect(second.body.operations.filter((op: any) => op.operation_type === "DECISION_VIEWED")).toHaveLength(1);
  });

  it("flips to decided after the decide endpoint", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    const dec = await client(app).post("/decisions/dec_1/decide", decide());
    expect(dec.status).toBe(200);
    const res = await client(app).get("/decisions/dec_1/acted-upon");
    expect(res.body.state).toBe("decided");
    expect(res.body.selected_option_id).toBe("opt_a");
    expect(res.body.acted_at).toBeTruthy();
    expect(res.body.actor).toMatchObject({ kind: "human", id: "chris", ref: "human:chris" });
    const ops = res.body.operations.map((o: any) => o.operation_type);
    expect(ops).toContain("DECISION_DECIDE");
  });

  it("shows a follow-up task operation and flips state to task_created", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    await client(app).post("/decisions/dec_1/decide", decide());
    const act = await client(app).post("/decisions/dec_1/actions", {
      action: "create_manager_task",
      actor: "human:chris",
      idempotency_key: "decision-action:v1:dec_1:create_manager_task:human:chris",
      artifact_id: "art_99",
    });
    expect(act.status).toBe(200);
    expect(act.body.operation.operation_type).toBe("DECISION_TASK_CREATED");
    expect(act.body.idempotent_replay).toBe(false);

    const res = await client(app).get("/decisions/dec_1/acted-upon");
    expect(res.body.state).toBe("task_created");
    const ops = res.body.operations.map((o: any) => o.operation_type);
    expect(ops).toContain("DECISION_DECIDE");
    expect(ops).toContain("DECISION_TASK_CREATED");
  });

  it("idempotent replay of an action returns the same operation", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    await client(app).post("/decisions/dec_1/decide", decide());
    const body = {
      action: "report_to_manager",
      actor: "human:chris",
      idempotency_key: "decision-action:v1:dec_1:report_to_manager:human:chris",
    };
    const first = await client(app).post("/decisions/dec_1/actions", body);
    const second = await client(app).post("/decisions/dec_1/actions", body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.idempotent_replay).toBe(true);
    expect(second.body.operation.operation_id).toBe(first.body.operation.operation_id);
  });

  it("returns 409 action_requires_decision when acting before deciding", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    const act = await client(app).post("/decisions/dec_1/actions", {
      action: "create_manager_task",
      actor: "human:chris",
      idempotency_key: "k1",
    });
    expect(act.status).toBe(409);
    expect(act.body.error).toBe("action_requires_decision");
  });

  it("returns 409 duplicate_idempotency_key when a key maps to a different payload", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    await client(app).post("/decisions/dec_1/decide", decide());
    const key = "dup-key";
    const a = await client(app).post("/decisions/dec_1/actions", {
      action: "create_manager_task",
      actor: "human:chris",
      idempotency_key: key,
      note_markdown: "first",
    });
    expect(a.status).toBe(200);
    const b = await client(app).post("/decisions/dec_1/actions", {
      action: "create_manager_task",
      actor: "human:chris",
      idempotency_key: key,
      note_markdown: "DIFFERENT",
    });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("duplicate_idempotency_key");
  });

  it("conflicting decide returns 409 decision_already_decided", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ options_json: JSON.stringify([
      { option_id: "opt_a", label: "A", value: "a", recommended: true, effect_summary: "" },
      { option_id: "opt_b", label: "B", value: "b", recommended: false, effect_summary: "" },
    ]) }));
    await client(app).post("/decisions/dec_1/decide", decide("opt_a", "k-a"));
    const conflict = await client(app).post("/decisions/dec_1/decide", decide("opt_b", "k-b"));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("decision_already_decided");
  });

  it("migrated-markdown decision surfaces provenance + a parser warning", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({
      provenance_json: JSON.stringify({
        producer: "maestra",
        parser_version: "decisions.parser.v3",
        source_path: "/Users/x/Dropbox/decisions.md",
        source_hash: "abc123",
        originating_artifact_id: "art_mig",
        originating_dispatch_id: "phid:disp-mig",
      }),
    }));
    const res = await client(app).get("/decisions/dec_1/acted-upon");
    expect(res.body.provenance.parser_version).toBe("decisions.parser.v3");
    expect(res.body.provenance.producer_dispatch_id).toBe("phid:disp-mig");
    expect(res.body.source.source_type).toBe("maestra_decisions_markdown");
    expect(res.body.artifact_id).toBe("art_mig");
    const codes = res.body.warnings.map((w: any) => w.code);
    expect(codes).toContain("migrated_from_markdown");
  });

  it("lists decision actions linked to an artifact", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow());
    await client(app).post("/decisions/dec_1/decide", decide());
    await client(app).post("/decisions/dec_1/actions", {
      action: "create_dispatch",
      actor: "human:chris",
      idempotency_key: "decision-action:v1:dec_1:create_dispatch:human:chris",
      artifact_id: "art_link",
    });
    const res = await client(app).get("/artifacts/art_link/decision-actions?limit=50");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("decision.actions.v1");
    expect(res.body.actions.length).toBe(1);
    expect(res.body.actions[0]).toMatchObject({
      decision_id: "dec_1",
      operation_type: "DECISION_DISPATCH_CREATED",
    });
  });
});
