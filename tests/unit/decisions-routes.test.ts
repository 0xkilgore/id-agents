// Kapelle decisions queue — route integration tests.
//
// Tests the mounted GET /decisions/queue and POST /decisions/:id/decide
// endpoints end-to-end via a tiny express app + in-memory sqlite. The
// queue MUST filter on the structured `status` column and never on
// prose/title heuristics; the response shape MUST match the OP-1
// contract spec (schema_version, source, freshness, provenance, filters,
// counts, items, warnings).

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  insertDecision,
  migrateDecisionsTables,
} from "../../src/decisions/storage.js";
import { mountDecisionsRoutes } from "../../src/decisions/routes.js";
import type { DecisionRow } from "../../src/decisions/types.js";

function makeRow(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decision_id: "dec_x",
    display_id: "#X",
    title: "Title",
    question: "Question?",
    context_excerpt: null,
    recommendation_json: null,
    options_json: null,
    status: "open",
    estimated_seconds: 60,
    priority: "normal",
    owner: "chris",
    requested_by: "maestra",
    created_at: "2026-06-09T20:00:00.000Z",
    updated_at: "2026-06-09T20:00:00.000Z",
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
  mountDecisionsRoutes(app, adapter, { now: () => new Date("2026-06-09T22:00:00.000Z") });
  return { app, adapter };
}

function request(app: Express) {
  return {
    async get(path: string): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") return reject(new Error("no address"));
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
            const text = await r.text();
            let parsed: any;
            try { parsed = JSON.parse(text); } catch { parsed = text; }
            server.close(() => resolve({ status: r.status, body: parsed }));
          } catch (e) { server.close(() => reject(e)); }
        });
      });
    },
    async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") return reject(new Error("no address"));
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const text = await r.text();
            let parsed: any;
            try { parsed = JSON.parse(text); } catch { parsed = text; }
            server.close(() => resolve({ status: r.status, body: parsed }));
          } catch (e) { server.close(() => reject(e)); }
        });
      });
    },
  };
}

describe("GET /decisions/queue — structured-status reader", () => {
  it("returns OP-1 contract envelope with schema_version, source, freshness, provenance, filters, counts, items, warnings", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "dec_only_open", status: "open" }));

    const res = await request(app).get("/decisions/queue?status=open");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.schema_version).toBe("decisions.queue.v1");
    expect(body.generated_at).toBeTruthy();
    expect(body.source.system).toBe("manager");
    expect(body.source.projection).toBe("decisions_queue");
    expect(body.source.source_type).toBe("manager_decisions_table");
    expect(body.freshness.status).toBe("fresh");
    expect(body.provenance.producer).toBe("manager");
    expect(body.provenance.parser_version).toBeTruthy();
    expect(body.filters.status).toBe("open");
    expect(body.filters.max_estimated_seconds).toBe(60);
    expect(body.filters.limit).toBe(8);
    expect(body.counts.open).toBe(1);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].decision_id).toBe("dec_only_open");
    expect(body.items[0].decide.method).toBe("POST");
    expect(body.items[0].decide.path).toBe("/decisions/dec_only_open/decide");
    expect(body.items[0].decide.idempotency_key_seed).toMatch(/^decision:decide:v1:dec_only_open:/);
  });

  it("DEFAULTS status to 'open' when omitted, and ALWAYS echoes filters.status in the response", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "dec_o", status: "open" }));
    await insertDecision(adapter, makeRow({ decision_id: "dec_r", status: "resolved" }));

    const res = await request(app).get("/decisions/queue"); // no ?status
    expect(res.status).toBe(200);
    expect(res.body.filters.status).toBe("open");
    expect(res.body.items.map((i: any) => i.decision_id)).toEqual(["dec_o"]);
  });

  it("REGRESSION — calendar #42-#45 records with appended RESOLVED metadata are NOT returned for status=open", async () => {
    const { app, adapter } = await bootApp();
    for (const id of ["dec_42", "dec_43", "dec_44", "dec_45"]) {
      await insertDecision(
        adapter,
        makeRow({
          decision_id: id,
          display_id: `#${id.split("_")[1]}`,
          status: "resolved",
          resolved_at: "2026-06-09T18:00:00.000Z",
          resolved_by: "human:chris",
        }),
      );
    }
    await insertDecision(adapter, makeRow({ decision_id: "dec_truly_open", status: "open" }));

    const res = await request(app).get("/decisions/queue?status=open");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.decision_id)).toEqual(["dec_truly_open"]);
    expect(res.body.counts.open).toBe(1);
    for (const id of ["dec_42", "dec_43", "dec_44", "dec_45"]) {
      expect(res.body.items.some((i: any) => i.decision_id === id)).toBe(false);
    }
  });

  it("REGRESSION — a row whose TITLE contains 'open' or whose prose looks open MUST NOT leak in when status=resolved", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(
      adapter,
      makeRow({
        decision_id: "dec_prose_open",
        title: "Confirm B1 reassignment trigger? RESOLVED 2026-06-09 inline",
        question: "Confirm B1 reassignment trigger Tue 2026-06-10 EOD if Roger silent?",
        status: "resolved",
      }),
    );

    const res = await request(app).get("/decisions/queue?status=open");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.counts.open).toBe(0);
  });

  it("honors max_estimated_seconds and limit filters", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "fast", status: "open", estimated_seconds: 30 }));
    await insertDecision(adapter, makeRow({ decision_id: "slow", status: "open", estimated_seconds: 300 }));

    const res = await request(app).get("/decisions/queue?status=open&max_estimated_seconds=60");
    expect(res.body.items.map((i: any) => i.decision_id)).toEqual(["fast"]);
    expect(res.body.filters.max_estimated_seconds).toBe(60);
  });
});

describe("POST /decisions/:decision_id/decide — idempotent decide", () => {
  it("returns ok + idempotent_replay:false on first call; status flips to resolved", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "dec_a", status: "open" }));

    const res = await request(app).post("/decisions/dec_a/decide", {
      actor: "human:chris",
      selected_option_id: "yes",
      idempotency_key: "decision:decide:v1:dec_a:yes:human:chris",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schema_version).toBe("decisions.decide.v1");
    expect(res.body.decision_id).toBe("dec_a");
    expect(res.body.status).toBe("decided");
    expect(res.body.selected_option_id).toBe("yes");
    expect(res.body.idempotent_replay).toBe(false);

    // Second call with same key replays.
    const replay = await request(app).post("/decisions/dec_a/decide", {
      actor: "human:chris",
      selected_option_id: "yes",
      idempotency_key: "decision:decide:v1:dec_a:yes:human:chris",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent_replay).toBe(true);
  });

  it("returns 409 decision_already_decided when re-deciding with a different option_id", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "dec_conflict", status: "open" }));

    await request(app).post("/decisions/dec_conflict/decide", {
      actor: "human:chris",
      selected_option_id: "yes",
      idempotency_key: "decision:decide:v1:dec_conflict:yes:human:chris",
    });

    const conflict = await request(app).post("/decisions/dec_conflict/decide", {
      actor: "human:chris",
      selected_option_id: "no",
      idempotency_key: "decision:decide:v1:dec_conflict:no:human:chris",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("decision_already_decided");
    expect(conflict.body.existing_selected_option_id).toBe("yes");
  });

  it("returns 404 when the decision_id does not exist", async () => {
    const { app } = await bootApp();
    const res = await request(app).post("/decisions/dec_unknown/decide", {
      actor: "human:chris",
      selected_option_id: "yes",
      idempotency_key: "decision:decide:v1:dec_unknown:yes:human:chris",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("decision_not_found");
  });

  it("returns 400 when input shape is invalid", async () => {
    const { app, adapter } = await bootApp();
    await insertDecision(adapter, makeRow({ decision_id: "dec_b", status: "open" }));

    const res = await request(app).post("/decisions/dec_b/decide", {
      // missing selected_option_id, actor, idempotency_key
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
