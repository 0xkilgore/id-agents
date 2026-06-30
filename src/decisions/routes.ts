// Kapelle decisions queue — Express routes.
//
// GET  /decisions/queue?status=open&max_estimated_seconds=60&limit=8
// POST /decisions/:decision_id/decide
//
// MUST filter on the structured `decisions.status` column. The OP-1
// contract envelope (schema_version, source, freshness, provenance,
// filters, counts, items, warnings) is always present so kapelle-site can
// render empty/stale/unavailable states uniformly.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  countDecisionsByStatus,
  getDecisionById,
  listActionEvents,
  listDecisionEvents,
  listDecisions,
  recordDecideTransaction,
  recordDecisionActionTransaction,
  recordDecisionViewedTransaction,
} from "./storage.js";
import { ingestDecisionsFromMarkdown, type IngestResult } from "./producer.js";
import type {
  ActorRef,
  DecideDecisionInput,
  DecideDecisionResponse,
  DecisionActedUponResponse,
  DecisionActedUponState,
  DecisionActionInput,
  DecisionActionResponse,
  DecisionActionsListItem,
  DecisionActionsListResponse,
  DecisionActionType,
  DecisionEventRow,
  DecisionOperation,
  DecisionOperationType,
  DecisionOption,
  DecisionQueueItem,
  DecisionRow,
  DecisionStatus,
  DecisionsQueueResponse,
  OpsProjectionFreshness,
  OpsProjectionProvenance,
  OpsProjectionSource,
  OpsProjectionWarning,
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
  /**
   * Auto-ingest the canonical Maestra decisions markdown on startup + on a
   * timer so `/decisions/queue` is continuously backed by the live source
   * without a manual POST. Default true; set DECISIONS_QUEUE_AUTOINGEST=false
   * to disable. Source path: DECISIONS_QUEUE_SOURCE_PATH or the canonical
   * agent-platform path.
   */
  autoIngest?: boolean;
  autoIngestSourcePath?: string;
  autoIngestIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** The canonical Maestra decisions source (overridable via env). */
export function defaultDecisionsSourcePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DECISIONS_QUEUE_SOURCE_PATH ||
    path.join(homedir(), "Dropbox", "Code", "agent-platform", "output", "kapelle-decisions-queue.md")
  );
}

export function mountDecisionsRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountDecisionsRoutesOptions = {},
): void {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  // Under Vitest, background filesystem IO stays disabled unless a test
  // explicitly opts this route into auto-ingest.
  const autoIngest =
    opts.autoIngest ??
    (!env.VITEST && !/^(0|false|no|off)$/i.test(env.DECISIONS_QUEUE_AUTOINGEST ?? ""));
  const autoIngestSourcePath = opts.autoIngestSourcePath ?? defaultDecisionsSourcePath(env);
  const autoIngestIntervalMs = opts.autoIngestIntervalMs ?? 10 * 60_000;
  let lastIngestResult: IngestResult | null = null;
  let lastIngestAttemptMs = 0;

  async function runAutoIngest(force = false): Promise<OpsProjectionWarning[]> {
    if (!autoIngest) return [];
    const elapsedMs = Date.now() - lastIngestAttemptMs;
    if (!force && lastIngestResult && elapsedMs < autoIngestIntervalMs) return [];
    lastIngestAttemptMs = Date.now();
    if (!existsSync(autoIngestSourcePath)) {
      return [{
        code: "decisions_source_missing",
        severity: "warning",
        message: `Decisions source not found: ${autoIngestSourcePath}`,
        source_ref: null,
      }];
    }
    try {
      const result = await ingestDecisionsFromMarkdown(adapter, {
        source_path: autoIngestSourcePath,
        now: now().toISOString(),
      });
      lastIngestResult = result;
      if (result.inserted > 0 || result.updated > 0) {
        console.log(
          `[decisions] ingested ${autoIngestSourcePath}: +${result.inserted}/${result.updated} ` +
            `(open=${result.open_count} resolved=${result.resolved_count} superseded=${result.superseded_count} ` +
            `declined=${result.declined_count}, skipped=${result.skipped.length})`,
        );
      }
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[decisions] auto-ingest failed for ${autoIngestSourcePath}: ${message}`);
      return [{
        code: "decisions_ingest_failed",
        severity: "error",
        message,
        source_ref: null,
      }];
    }
  }

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
        const ingestWarnings = await runAutoIngest(false);

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
            source_type: lastIngestResult ? "maestra_decisions_markdown" : "manager_decisions_table",
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
            producer: lastIngestResult ? "maestra" : "manager",
            producer_task_name: null,
            producer_dispatch_id: null,
            parser_version: lastIngestResult?.parser_version ?? QUEUE_PARSER_VERSION,
            source_hash: lastIngestResult?.source_hash ?? null,
            source_paths: lastIngestResult ? [lastIngestResult.source_path] : [],
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
          warnings: ingestWarnings,
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

  // POST /decisions/ingest — operator-triggered re-ingest from the
  // Maestra source markdown. Body: { source_path: string }. The
  // producer reads the file, runs the safe-by-construction parser, and
  // upserts each classified row into the decisions table. Returns an
  // IngestResult so the operator can see inserted/updated counts +
  // any skipped rows. The endpoint is intentionally idempotent: a
  // re-ingest with the same source produces zero new rows and updates
  // any rows whose Maestra-side status changed since last call.
  app.post("/decisions/ingest", async (req: Request, res: Response) => {
    try {
      const sourcePath = typeof req.body?.source_path === "string" ? req.body.source_path : null;
      if (!sourcePath) {
        res.status(400).json({
          ok: false,
          error: "source_path_required",
          message: "body.source_path must be an absolute path to a decisions markdown file",
        });
        return;
      }
      // Guard against path traversal — accept absolute paths only.
      if (!sourcePath.startsWith("/")) {
        res.status(400).json({
          ok: false,
          error: "source_path_must_be_absolute",
          message: `source_path must start with '/' (got ${sourcePath.slice(0, 64)})`,
        });
        return;
      }
      const result = await ingestDecisionsFromMarkdown(adapter, {
        source_path: sourcePath,
        now: now().toISOString(),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        error: "ingest_failed",
        message,
      });
    }
  });

  // ── P5: acted-upon read model ────────────────────────────────────────
  // GET /decisions/:decision_id/acted-upon — derives acted-upon/decided
  // state from the decision row status + the append-only decision_events
  // log (operations). Never inferred from prose.
  app.get(
    "/decisions/:decision_id/acted-upon",
    async (req: Request<{ decision_id: string }>, res: Response) => {
      try {
        const decisionId = req.params.decision_id;
        if (!decisionId || typeof decisionId !== "string") {
          res.status(400).json({ ok: false, error: "invalid_decision_id" });
          return;
        }
        const row = await getDecisionById(adapter, decisionId);
        if (!row) {
          res.status(404).json({ ok: false, error: "decision_not_found" });
          return;
        }
        const generatedAt = now().toISOString();
        await recordDecisionViewedTransaction(adapter, {
          decision_id: decisionId,
          actor: "human:chris",
          now: generatedAt,
        });
        const events = await listDecisionEvents(adapter, decisionId);
        res.json(buildActedUpon(row, events, generatedAt));
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: "projection_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // POST /decisions/:decision_id/actions — typed, append-only follow-up
  // operation on a DECIDED decision (create_manager_task / create_dispatch
  // / report_to_manager). Idempotent by idempotency_key.
  app.post(
    "/decisions/:decision_id/actions",
    async (req: Request<{ decision_id: string }>, res: Response) => {
      try {
        const validation = validateActionInput(req.body);
        if (!validation.ok) {
          res.status(400).json({ ok: false, error: validation.error, message: validation.message });
          return;
        }
        const input = validation.value;
        const result = await recordDecisionActionTransaction(adapter, {
          decision_id: req.params.decision_id,
          action: input.action,
          actor: input.actor,
          idempotency_key: input.idempotency_key,
          note_markdown: input.note_markdown ?? null,
          artifact_id: input.artifact_id ?? null,
          source_panel: input.source_panel ?? null,
          now: now().toISOString(),
        });

        if (result.kind === "not_found") {
          res.status(404).json({ ok: false, error: "decision_not_found" });
          return;
        }
        if (result.kind === "requires_decision") {
          res.status(409).json({
            ok: false,
            error: "action_requires_decision",
            decision_status: result.status,
          });
          return;
        }
        if (result.kind === "key_conflict") {
          res.status(409).json({ ok: false, error: "duplicate_idempotency_key" });
          return;
        }

        const operation = eventToOperation(result.event);
        if (!operation) {
          res.status(500).json({ ok: false, error: "operation_write_failed" });
          return;
        }
        const response: DecisionActionResponse = {
          ok: true,
          schema_version: "decision.action.v1",
          decision_id: req.params.decision_id,
          operation,
          idempotent_replay: result.kind === "idempotent_replay",
        };
        res.json(response);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: "operation_write_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // GET /artifacts/:artifact_id/decision-actions?limit=50 — decision action
  // operations linked to an artifact (by action artifact_id OR the source
  // decision's originating_artifact_id).
  app.get(
    "/artifacts/:artifact_id/decision-actions",
    async (req: Request<{ artifact_id: string }>, res: Response) => {
      try {
        const artifactId = req.params.artifact_id;
        if (!artifactId || typeof artifactId !== "string") {
          res.status(400).json({ ok: false, error: "invalid_artifact_id" });
          return;
        }
        const limit = parsePositiveInt(req.query.limit, 50);
        const events = await listActionEvents(adapter, 1000);
        const decisionCache = new Map<string, DecisionRow | null>();
        const items: DecisionActionsListItem[] = [];
        for (const e of events) {
          const payload = safeParseJson<Record<string, unknown>>(e.payload_json) ?? {};
          let linked = stringOrNull(payload.artifact_id) === artifactId;
          if (!linked) {
            if (!decisionCache.has(e.decision_id)) {
              decisionCache.set(e.decision_id, await getDecisionById(adapter, e.decision_id));
            }
            const decision = decisionCache.get(e.decision_id) ?? null;
            if (decision) {
              const dp = safeParseJson<Record<string, unknown>>(decision.provenance_json) ?? {};
              linked = stringOrNull(dp.originating_artifact_id) === artifactId;
            }
          }
          if (!linked) continue;
          const op = eventToOperation(e);
          if (op) items.push({ ...op, decision_id: e.decision_id });
          if (items.length >= limit) break;
        }
        const generatedAt = now().toISOString();
        const response: DecisionActionsListResponse = {
          ok: true,
          schema_version: "decision.actions.v1",
          generated_at: generatedAt,
          artifact_id: artifactId,
          limit,
          actions: items,
          source: {
            system: "manager",
            projection: "decision_actions",
            source_type: "manager_decisions_table",
            source_refs: [],
          },
          freshness: freshnessNow(generatedAt),
          provenance: {
            producer: "manager",
            producer_task_name: null,
            producer_dispatch_id: null,
            parser_version: "decision.actions.v1",
            source_hash: null,
            source_paths: [],
          },
          warnings: [],
        };
        res.json(response);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: "projection_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── Auto-ingest: keep the decisions table backed by the live Maestra source ──
  // Without this the route renders but the table stays empty until an operator
  // POSTs /decisions/ingest by hand — so the panel showed no live decisions.
  // Mirrors the usage-meter transcript-ingest pattern (best-effort, self-
  // refreshing). Idempotent upserts mean re-ingest is cheap + safe.
  if (autoIngest) {
    setTimeout(() => void runAutoIngest(true), 0).unref?.();
    const timer = setInterval(() => void runAutoIngest(true), autoIngestIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }
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

// ── P5 helpers: acted-upon projection + decision actions ───────────────

const ACTED_UPON_PARSER_VERSION = "decision.acted-upon.v1";
const VALID_ACTIONS = new Set<DecisionActionType>([
  "create_manager_task",
  "create_dispatch",
  "report_to_manager",
]);
const OP_TYPE_BY_EVENT: Record<string, DecisionOperationType> = {
  "decision.viewed": "DECISION_VIEWED",
  "decision.decided": "DECISION_DECIDE",
  "decision.action.create_manager_task": "DECISION_TASK_CREATED",
  "decision.action.create_dispatch": "DECISION_DISPATCH_CREATED",
  "decision.action.report_to_manager": "DECISION_REPORT_TO_MANAGER",
  "decision.superseded": "DECISION_SUPERSEDED",
};

/** Parse a canonical actor string (e.g. "human:chris") into a structured ref. */
function parseActorRef(actor: string | null | undefined): ActorRef {
  const ref = typeof actor === "string" && actor.length > 0 ? actor : "unknown:unknown";
  const idx = ref.indexOf(":");
  const rawKind = idx >= 0 ? ref.slice(0, idx) : ref;
  const id = idx >= 0 ? ref.slice(idx + 1) : ref;
  const kind: ActorRef["kind"] =
    rawKind === "human" || rawKind === "agent" || rawKind === "system" ? rawKind : "unknown";
  return { kind, id: id || rawKind, ref, label: null };
}

/** Map a decision_event row to a typed operation, or null if it is not an operation. */
function eventToOperation(e: DecisionEventRow): DecisionOperation | null {
  const opType = OP_TYPE_BY_EVENT[e.event_type];
  if (!opType) return null;
  const payload = safeParseJson<Record<string, unknown>>(e.payload_json) ?? {};
  const targetRefs = Array.isArray(payload.target_refs)
    ? (payload.target_refs as SourceRef[])
    : [];
  const idempotencyKey = typeof payload.idempotency_key === "string" ? payload.idempotency_key : "";
  return {
    operation_id: e.event_id,
    operation_type: opType,
    created_at: e.created_at,
    actor: parseActorRef(e.actor),
    target_refs: targetRefs,
    idempotency_key: idempotencyKey,
  };
}

function freshnessNow(generatedAt: string): OpsProjectionFreshness {
  return {
    status: "fresh",
    generated_at: generatedAt,
    source_updated_at: null,
    projection_updated_at: null,
    max_age_seconds: 600,
  };
}

function coerceProducer(raw: unknown): OpsProjectionProvenance["producer"] {
  return raw === "maestra" || raw === "manager" || raw === "migration" ? raw : "unknown";
}

function buildActedUpon(
  row: DecisionRow,
  events: DecisionEventRow[],
  generatedAt: string,
): DecisionActedUponResponse {
  const operations = events
    .map(eventToOperation)
    .filter((op): op is DecisionOperation => op !== null);
  const provenanceRaw = safeParseJson<Record<string, unknown>>(row.provenance_json) ?? {};
  const artifactId = stringOrNull(provenanceRaw.originating_artifact_id);

  const decideOp = operations.find((o) => o.operation_type === "DECISION_DECIDE") ?? null;
  const actionOps = operations.filter(
    (o) =>
      o.operation_type === "DECISION_TASK_CREATED" ||
      o.operation_type === "DECISION_DISPATCH_CREATED" ||
      o.operation_type === "DECISION_REPORT_TO_MANAGER",
  );
  // events arrive oldest-first, so the last action op is the most recent.
  const latestAction = actionOps.length > 0 ? actionOps[actionOps.length - 1] : null;

  let state: DecisionActedUponState;
  if (row.status === "superseded") {
    state = "superseded";
  } else if (latestAction) {
    state =
      latestAction.operation_type === "DECISION_TASK_CREATED"
        ? "task_created"
        : latestAction.operation_type === "DECISION_DISPATCH_CREATED"
          ? "dispatch_created"
          : "reported_to_manager";
  } else if (row.status === "resolved") {
    state = "decided";
  } else {
    state = "not_acted";
  }

  const actedAt = decideOp?.created_at ?? (state === "superseded" ? row.updated_at : null);
  const actor = decideOp?.actor ?? latestAction?.actor ?? null;

  const producer = coerceProducer(provenanceRaw.producer);
  const sourceType =
    producer === "maestra"
      ? "maestra_decisions_markdown"
      : producer === "migration"
        ? "hybrid_projection"
        : "manager_decisions_table";
  const source: OpsProjectionSource = {
    system: "manager",
    projection: "decision_acted_upon",
    source_type: sourceType,
    source_refs: safeParseJson<SourceRef[]>(row.source_refs_json) ?? [],
  };
  const provenance: OpsProjectionProvenance = {
    producer,
    producer_task_name: stringOrNull(provenanceRaw.originating_task_name),
    producer_dispatch_id: stringOrNull(provenanceRaw.originating_dispatch_id),
    parser_version:
      typeof provenanceRaw.parser_version === "string"
        ? provenanceRaw.parser_version
        : ACTED_UPON_PARSER_VERSION,
    source_hash: stringOrNull(provenanceRaw.source_hash),
    source_paths: stringOrNull(provenanceRaw.source_path)
      ? [provenanceRaw.source_path as string]
      : [],
  };

  const warnings: OpsProjectionWarning[] = [];
  if (producer === "maestra" || producer === "migration") {
    warnings.push({
      code: "migrated_from_markdown",
      severity: "info",
      message:
        "Decision originated from Maestra markdown; acted-upon state is a projection over migrated provenance.",
      source_ref: null,
    });
  }

  return {
    ok: true,
    schema_version: "decision.acted-upon.v1",
    generated_at: generatedAt,
    decision_id: row.decision_id,
    artifact_id: artifactId,
    state,
    selected_option_id: row.selected_option_id,
    acted_at: actedAt,
    actor,
    operations,
    source,
    freshness: freshnessNow(generatedAt),
    provenance,
    warnings,
  };
}

function validateActionInput(
  body: Partial<DecisionActionInput> | undefined,
): ValidationResult<DecisionActionInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body", message: "POST body must be a JSON object" };
  }
  if (body.actor !== "human:chris") {
    return { ok: false, error: "invalid_actor", message: "actor must be 'human:chris'" };
  }
  if (!body.action || !VALID_ACTIONS.has(body.action)) {
    return {
      ok: false,
      error: "invalid_action",
      message: "action must be one of: create_manager_task, create_dispatch, report_to_manager",
    };
  }
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return { ok: false, error: "idempotency_key_required", message: "idempotency_key is required" };
  }
  return {
    ok: true,
    value: {
      action: body.action,
      actor: body.actor,
      idempotency_key: body.idempotency_key,
      note_markdown: typeof body.note_markdown === "string" ? body.note_markdown : undefined,
      source_panel: body.source_panel,
      artifact_id: typeof body.artifact_id === "string" ? body.artifact_id : undefined,
    },
  };
}
