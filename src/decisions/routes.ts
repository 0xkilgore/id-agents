// Kapelle decisions queue — Express routes.
//
// GET  /decisions/queue?status=open&max_estimated_seconds=60&limit=8
// POST /decisions/:decision_id/decide
//
// MUST filter on the structured `decisions.status` column. The OP-1
// contract envelope (schema_version, source, freshness, provenance,
// filters, counts, items, warnings) is always present so kapelle-site can
// render empty/stale/unavailable states uniformly.

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  countDecisionsByStatus,
  getDecisionById,
  listDecisions,
  recordDecideTransaction,
} from "./storage.js";
import type {
  DecideDecisionInput,
  DecideDecisionResponse,
  DecisionOption,
  DecisionQueueItem,
  DecisionRow,
  DecisionStatus,
  DecisionsQueueResponse,
  SourceRef,
} from "./types.js";

export const QUEUE_PARSER_VERSION = "decisions.queue.v1";
const VALID_STATUSES = new Set<DecisionStatus>([
  "open",
  "resolved",
  "superseded",
  "declined",
]);

export interface MountDecisionsRoutesOptions {
  now?: () => Date;
}

export function mountDecisionsRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountDecisionsRoutesOptions = {},
): void {
  const now = opts.now ?? (() => new Date());

  app.get(
    "/decisions/queue",
    async (req: Request, res: Response) => {
      try {
        const status = parseStatus(req.query.status);
        if (!status) {
          res.status(400).json({
            ok: false,
            error: "invalid_status",
            message:
              "status must be one of: open, resolved, superseded, declined",
          });
          return;
        }
        const maxEstimatedSeconds = parsePositiveInt(req.query.max_estimated_seconds, 60);
        const limit = parsePositiveInt(req.query.limit, 8);

        const rows = await listDecisions(adapter, {
          status,
          max_estimated_seconds: maxEstimatedSeconds,
          limit,
        });
        const openCount = await countDecisionsByStatus(adapter, "open");

        const generatedAt = now().toISOString();
        const items: DecisionQueueItem[] = rows.map(rowToQueueItem);

        const response: DecisionsQueueResponse = {
          schema_version: "decisions.queue.v1",
          generated_at: generatedAt,
          source: {
            system: "manager",
            projection: "decisions_queue",
            source_type: "manager_decisions_table",
            source_refs: [],
          },
          freshness: {
            status: "fresh",
            generated_at: generatedAt,
            source_updated_at: null,
            projection_updated_at: null,
            max_age_seconds: 600,
          },
          provenance: {
            producer: "manager",
            producer_task_name: null,
            producer_dispatch_id: null,
            parser_version: QUEUE_PARSER_VERSION,
            source_hash: null,
            source_paths: [],
          },
          filters: {
            status,
            max_estimated_seconds: maxEstimatedSeconds,
            limit,
          },
          counts: {
            open: openCount,
            visible: items.length,
            stale: 0,
            blocked: items.filter((i) => i.status === "blocked").length,
          },
          items,
          warnings: [],
        };
        res.json(response);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    "/decisions/:decision_id/decide",
    async (req: Request<{ decision_id: string }>, res: Response) => {
      try {
        const body = req.body as Partial<DecideDecisionInput> | undefined;
        const validation = validateDecideInput(body);
        if (!validation.ok) {
          res.status(400).json({
            ok: false,
            error: validation.error,
            message: validation.message,
          });
          return;
        }
        const input = validation.value;
        const result = await recordDecideTransaction(adapter, {
          decision_id: req.params.decision_id,
          selected_option_id: input.selected_option_id,
          actor: input.actor,
          idempotency_key: input.idempotency_key,
          note_markdown: input.note_markdown ?? null,
          now: now().toISOString(),
        });

        if (result.kind === "not_found") {
          res.status(404).json({ ok: false, error: "decision_not_found" });
          return;
        }
        if (result.kind === "conflict") {
          res.status(409).json({
            ok: false,
            error: "decision_already_decided",
            existing_selected_option_id: result.existing_selected_option_id,
          });
          return;
        }

        if (result.kind === "idempotent_replay") {
          const response: DecideDecisionResponse = {
            ok: true,
            schema_version: "decisions.decide.v1",
            decision_id: req.params.decision_id,
            operation_id: result.existing_event.event_id,
            status: "decided",
            selected_option_id: input.selected_option_id,
            decided_at: result.existing_event.created_at,
            idempotent_replay: true,
          };
          res.json(response);
          return;
        }

        const response: DecideDecisionResponse = {
          ok: true,
          schema_version: "decisions.decide.v1",
          decision_id: req.params.decision_id,
          operation_id: result.event_id,
          status: "decided",
          selected_option_id: input.selected_option_id,
          decided_at: now().toISOString(),
          idempotent_replay: false,
        };
        res.json(response);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

function parseStatus(raw: unknown): DecisionStatus | null {
  if (raw === undefined || raw === null || raw === "") return "open";
  if (typeof raw !== "string") return null;
  return VALID_STATUSES.has(raw as DecisionStatus) ? (raw as DecisionStatus) : null;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function safeParseJson<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rowToQueueItem(row: DecisionRow): DecisionQueueItem {
  const options =
    safeParseJson<DecisionOption[]>(row.options_json) ?? [];
  const recommendation =
    safeParseJson<DecisionQueueItem["recommendation"]>(row.recommendation_json) ?? {
      option_id: "skip",
      label: "Skip",
      rationale: "No recommendation recorded; operator decides on the merits.",
      confidence: "low",
    };
  const sourceRefs = safeParseJson<SourceRef[]>(row.source_refs_json) ?? [];
  const provenanceRaw = safeParseJson<Record<string, unknown>>(row.provenance_json) ?? {};
  const oneTapOptionId = recommendation.option_id;
  const idempotencyKeySeed = `decision:decide:v1:${row.decision_id}:${oneTapOptionId}:human:chris`;

  return {
    decision_id: row.decision_id,
    display_id: row.display_id ?? row.decision_id,
    title: row.title,
    question: row.question,
    context_excerpt: row.context_excerpt ?? "",
    recommendation,
    options,
    status: row.status === "open" ? "open" : "blocked",
    estimated_seconds: row.estimated_seconds ?? 60,
    priority: row.priority,
    owner: "chris",
    requested_by: row.requested_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stale_after: null,
    source_refs: sourceRefs,
    provenance: {
      source_path: stringOrNull(provenanceRaw.source_path),
      source_anchor: stringOrNull(provenanceRaw.source_anchor),
      source_hash: stringOrNull(provenanceRaw.source_hash),
      originating_artifact_id: stringOrNull(provenanceRaw.originating_artifact_id),
      originating_task_name: stringOrNull(provenanceRaw.originating_task_name),
      originating_dispatch_id: stringOrNull(provenanceRaw.originating_dispatch_id),
    },
    decide: {
      method: "POST",
      path: `/decisions/${row.decision_id}/decide`,
      one_tap_option_id: oneTapOptionId,
      idempotency_key_seed: idempotencyKeySeed,
      requires_note: false,
      confirmation: "none",
    },
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string };

function validateDecideInput(
  body: Partial<DecideDecisionInput> | undefined,
): ValidationResult<DecideDecisionInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body", message: "POST body must be a JSON object" };
  }
  if (body.actor !== "human:chris") {
    return { ok: false, error: "invalid_actor", message: "actor must be 'human:chris'" };
  }
  if (!body.selected_option_id || typeof body.selected_option_id !== "string") {
    return { ok: false, error: "selected_option_id_required", message: "selected_option_id is required" };
  }
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return { ok: false, error: "idempotency_key_required", message: "idempotency_key is required" };
  }
  return {
    ok: true,
    value: {
      actor: body.actor,
      selected_option_id: body.selected_option_id,
      idempotency_key: body.idempotency_key,
      note_markdown: typeof body.note_markdown === "string" ? body.note_markdown : undefined,
      source_panel: body.source_panel,
    },
  };
}
