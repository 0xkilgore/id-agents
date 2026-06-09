// Kapelle decisions queue — storage layer.
//
// Two tables:
//   - decisions:        canonical row per decision; status is a CHECK-constrained
//                       column. Readers MUST filter on this column, never on prose.
//   - decision_events:  append-only lifecycle log. The decide() transaction
//                       updates the decision row + appends an event atomically.

import { randomUUID } from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type {
  DecisionEventRow,
  DecisionRow,
  DecisionStatus,
} from "./types.js";

export async function migrateDecisionsTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS decisions (
      decision_id          TEXT PRIMARY KEY,
      display_id           TEXT,
      title                TEXT NOT NULL,
      question             TEXT NOT NULL,
      context_excerpt      TEXT,
      recommendation_json  TEXT,
      options_json         TEXT,
      status               TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'superseded', 'declined')),
      estimated_seconds    INTEGER,
      priority             TEXT NOT NULL DEFAULT 'normal',
      owner                TEXT NOT NULL DEFAULT 'chris',
      requested_by         TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      resolved_at          TEXT,
      resolved_by          TEXT,
      resolution_note      TEXT,
      selected_option_id   TEXT,
      source_refs_json     TEXT NOT NULL,
      provenance_json      TEXT NOT NULL
    )
  `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS decisions_status_idx ON decisions(status, created_at)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS decisions_owner_idx ON decisions(owner, status)`,
    [],
  );
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS decision_events (
      event_id     TEXT PRIMARY KEY,
      decision_id  TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      actor        TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS decision_events_decision_idx ON decision_events(decision_id, created_at)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS decision_events_type_idx ON decision_events(decision_id, event_type)`,
    [],
  );
}

export async function insertDecision(adapter: DbAdapter, row: DecisionRow): Promise<void> {
  await adapter.query(
    `INSERT INTO decisions
       (decision_id, display_id, title, question, context_excerpt,
        recommendation_json, options_json, status, estimated_seconds, priority,
        owner, requested_by, created_at, updated_at, resolved_at, resolved_by,
        resolution_note, selected_option_id, source_refs_json, provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.decision_id, row.display_id, row.title, row.question, row.context_excerpt,
      row.recommendation_json, row.options_json, row.status, row.estimated_seconds, row.priority,
      row.owner, row.requested_by, row.created_at, row.updated_at, row.resolved_at, row.resolved_by,
      row.resolution_note, row.selected_option_id, row.source_refs_json, row.provenance_json,
    ],
  );
}

export interface ListFilters {
  status: DecisionStatus;
  max_estimated_seconds?: number;
  limit?: number;
  owner?: string;
}

export async function listDecisions(
  adapter: DbAdapter,
  filters: ListFilters,
): Promise<DecisionRow[]> {
  const clauses: string[] = ["status = ?"];
  const params: unknown[] = [filters.status];
  if (typeof filters.max_estimated_seconds === "number") {
    clauses.push("(estimated_seconds IS NULL OR estimated_seconds <= ?)");
    params.push(filters.max_estimated_seconds);
  }
  if (filters.owner) {
    clauses.push("owner = ?");
    params.push(filters.owner);
  }
  const limit = Math.min(filters.limit ?? 8, 100);
  const sql = `
    SELECT * FROM decisions
    WHERE ${clauses.join(" AND ")}
    ORDER BY priority = 'critical' DESC,
             priority = 'high' DESC,
             priority = 'normal' DESC,
             created_at ASC,
             decision_id ASC
    LIMIT ?
  `;
  params.push(limit);
  const { rows } = await adapter.query<DecisionRow>(sql, params);
  return rows;
}

export async function getDecisionById(
  adapter: DbAdapter,
  decisionId: string,
): Promise<DecisionRow | null> {
  const { rows } = await adapter.query<DecisionRow>(
    `SELECT * FROM decisions WHERE decision_id = ?`,
    [decisionId],
  );
  return rows[0] ?? null;
}

export async function countDecisionsByStatus(
  adapter: DbAdapter,
  status: DecisionStatus,
): Promise<number> {
  const { rows } = await adapter.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM decisions WHERE status = ?`,
    [status],
  );
  return Number(rows[0]?.c ?? 0);
}

export interface AppendEventInput {
  decision_id: string;
  event_type: string;
  actor: string;
  created_at: string;
  payload_json: string;
}

export async function appendDecisionEvent(
  adapter: DbAdapter,
  input: AppendEventInput,
): Promise<string> {
  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await adapter.query(
    `INSERT INTO decision_events
       (event_id, decision_id, event_type, actor, created_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [eventId, input.decision_id, input.event_type, input.actor, input.created_at, input.payload_json],
  );
  return eventId;
}

export async function findDecidedEventForDecision(
  adapter: DbAdapter,
  decisionId: string,
): Promise<DecisionEventRow | null> {
  const { rows } = await adapter.query<DecisionEventRow>(
    `SELECT * FROM decision_events
       WHERE decision_id = ? AND event_type = 'decision.decided'
       ORDER BY created_at ASC LIMIT 1`,
    [decisionId],
  );
  return rows[0] ?? null;
}

export interface RecordDecideInput {
  decision_id: string;
  selected_option_id: string;
  actor: "human:chris";
  idempotency_key: string;
  note_markdown: string | null;
  now: string;
}

export type RecordDecideResult =
  | { kind: "recorded"; event_id: string }
  | { kind: "idempotent_replay"; existing_event: DecisionEventRow }
  | { kind: "conflict"; existing_selected_option_id: string; existing_event: DecisionEventRow }
  | { kind: "not_found" };

export async function recordDecideTransaction(
  adapter: DbAdapter,
  input: RecordDecideInput,
): Promise<RecordDecideResult> {
  const decision = await getDecisionById(adapter, input.decision_id);
  if (!decision) return { kind: "not_found" };

  // Idempotency / conflict checks: scan for an existing decision.decided event.
  const existing = await findDecidedEventForDecision(adapter, input.decision_id);
  if (existing) {
    const payload = safeParseJson(existing.payload_json) as Record<string, unknown> | null;
    const existingOpt = typeof payload?.selected_option_id === "string"
      ? (payload.selected_option_id as string)
      : null;
    if (existingOpt && existingOpt === input.selected_option_id) {
      return { kind: "idempotent_replay", existing_event: existing };
    }
    return {
      kind: "conflict",
      existing_selected_option_id: existingOpt ?? "<unknown>",
      existing_event: existing,
    };
  }

  // Transactional write. SqliteAdapter doesn't expose a generic
  // BEGIN/COMMIT helper, so issue the two writes back-to-back and rely on
  // SQLite's implicit single-statement durability; the only failure mode
  // we care about here is process crash between the two queries — in
  // that case the next decide call will see an open decision row but a
  // matching event row, and the second call will return
  // idempotent_replay or conflict per the existing-event branch above.
  await adapter.query(`BEGIN`, []);
  try {
    await adapter.query(
      `UPDATE decisions
         SET status = 'resolved',
             resolved_at = ?,
             resolved_by = ?,
             selected_option_id = ?,
             resolution_note = ?,
             updated_at = ?
       WHERE decision_id = ?`,
      [
        input.now,
        input.actor,
        input.selected_option_id,
        input.note_markdown ?? null,
        input.now,
        input.decision_id,
      ],
    );
    const payload = {
      schema_version: "decision.decided.v1",
      selected_option_id: input.selected_option_id,
      idempotency_key: input.idempotency_key,
      note_markdown: input.note_markdown,
      source_panel: "ops_decisions_queue",
    };
    const eventId = await appendDecisionEvent(adapter, {
      decision_id: input.decision_id,
      event_type: "decision.decided",
      actor: input.actor,
      created_at: input.now,
      payload_json: JSON.stringify(payload),
    });
    await adapter.query(`COMMIT`, []);
    return { kind: "recorded", event_id: eventId };
  } catch (err) {
    await adapter.query(`ROLLBACK`, []).catch(() => undefined);
    throw err;
  }
}

function safeParseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
