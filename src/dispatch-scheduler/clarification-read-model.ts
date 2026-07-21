import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";
import { migrateDispatchAttemptLedger } from "../dispatch-attempt-ledger/storage.js";
import { readDispatchById } from "./read-model.js";

type JsonObject = Record<string, unknown>;

export type ClarificationReadResult =
  | { kind: "ok"; value: JsonObject }
  | { kind: "dispatch_not_found" }
  | { kind: "clarification_not_found" }
  | { kind: "evidence_unlinked" }
  | { kind: "result_malformed"; original_query_id: string };

interface EvidenceRow {
  ledger_id: string;
  original_query_id: string | null;
  query_status: string | null;
  query_result: unknown;
}

/** Durable, team-scoped clarification read for the Action Center. */
export async function readDispatchClarification(
  adapter: DbAdapterLike,
  teamId: string,
  dispatchId: string,
  deriveOpts: Parameters<typeof readDispatchById>[3],
  nowMs = Date.now(),
): Promise<ClarificationReadResult> {
  const dispatch = await readDispatchById(adapter, teamId, dispatchId, deriveOpts);
  if (!dispatch) return { kind: "dispatch_not_found" };

  const history = dispatch.needs_input.history.filter(isObject);
  const filedEvents = history.filter((event) => event.type === "NEEDS_CLARIFICATION");
  if (filedEvents.length === 0 && !dispatch.needs_input.active) {
    return { kind: "clarification_not_found" };
  }

  await migrateDispatchAttemptLedger(adapter as Parameters<typeof migrateDispatchAttemptLedger>[0]);
  const evidence = await adapter.query<EvidenceRow>(
    `SELECT dal.id AS ledger_id,
            dal.original_query_id,
            q.status AS query_status,
            q.result AS query_result
       FROM dispatch_attempt_ledger dal
       LEFT JOIN queries q
         ON q.team_id = dal.team_id
        AND q.query_id = dal.original_query_id
      WHERE dal.team_id = ?
        AND dal.original_dispatch_id = ?
      ORDER BY dal.updated_at DESC, dal.id DESC`,
    [teamId, dispatchId],
  );

  if (evidence.rows.length === 0 || evidence.rows.every((row) => !row.original_query_id || row.query_result == null)) {
    return { kind: "evidence_unlinked" };
  }

  const latestFiled = filedEvents[filedEvents.length - 1] ?? null;
  const active = isObject(dispatch.needs_input.active) ? dispatch.needs_input.active : null;
  const targetClarificationId = stringField(active, "clarification_id") ?? stringField(latestFiled, "clarification_id");

  for (const row of evidence.rows) {
    if (!row.original_query_id || row.query_result == null) continue;
    const payload = findNeedsInputPayload(parseQueryResult(row.query_result), dispatchId, targetClarificationId);
    if (!payload) continue;

    const clarificationId = stringField(payload, "clarification_id") ?? targetClarificationId;
    const filed = filedEvents.find((event) => stringField(event, "clarification_id") === clarificationId) ?? latestFiled ?? null;
    const resume = history.find((event) =>
      event.type === "RESUME" && (!clarificationId || stringField(event, "clarification_id") === clarificationId)) ?? null;
    const filedAt = stringField(payload, "created_at") ?? stringField(payload, "filed_at") ?? stringField(filed, "ts");
    const staleAt = stringField(payload, "stale_at") ?? stringField(filed, "stale_at");
    const answeredAt = stringField(resume, "ts");
    const state = resume ? "answered" : "open";
    const clarification: JsonObject = {
      clarification_id: clarificationId ?? null,
      state,
      filed_at: filedAt ?? null,
      stale_at: staleAt ?? null,
      age_seconds: filedAt ? Math.max(0, Math.floor((nowMs - Date.parse(filedAt)) / 1000)) : 0,
      agent_id: stringField(payload, "agent_id") ?? stringField(filed, "agent_id") ?? dispatch.agent_id,
      question: stringField(payload, "question"),
      context: payload.context ?? filed?.context ?? null,
      urgency: stringField(payload, "urgency") ?? stringField(filed, "urgency") ?? "normal",
      owner_class: needsChris(payload) ? "needs_chris" : "operational",
    };
    if (resume) {
      clarification.answered_at = answeredAt ?? null;
      clarification.answer = stringField(resume, "answer") ?? null;
      clarification.answered_by = stringField(resume, "actor") ?? null;
    }
    return {
      kind: "ok",
      value: {
        ok: true,
        schema_version: "dispatch-clarification-read.v1",
        dispatch_id: dispatchId,
        dispatch_state: dispatch.status,
        clarification,
        source: {
          body: "queries.result",
          link: "dispatch_attempt_ledger.original_query_id",
          original_query_id: row.original_query_id,
          complete: true,
        },
      },
    };
  }

  const firstLinked = evidence.rows.find((row) => row.original_query_id && row.query_result != null);
  return { kind: "result_malformed", original_query_id: firstLinked!.original_query_id! };
}

function parseQueryResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function findNeedsInputPayload(value: unknown, dispatchId: string, clarificationId: string | null): JsonObject | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): JsonObject | null => {
    if (typeof node === "string") {
      try { return visit(JSON.parse(node)); } catch { return null; }
    }
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) { const found = visit(child); if (found) return found; }
      return null;
    }
    const object = node as JsonObject;
    const question = stringField(object, "question");
    const candidateDispatchId = stringField(object, "dispatch_id");
    const candidateClarificationId = stringField(object, "clarification_id");
    if (question && candidateDispatchId === dispatchId && (!clarificationId || !candidateClarificationId || candidateClarificationId === clarificationId)) {
      return object;
    }
    for (const child of Object.values(object)) { const found = visit(child); if (found) return found; }
    return null;
  };
  return visit(value);
}

function needsChris(payload: JsonObject): boolean {
  return payload.needs_chris === true || payload.requires_chris === true || payload.needs_you === true;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: JsonObject | null, field: string): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
