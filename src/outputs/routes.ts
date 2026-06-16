// Kapelle B11 manager-side backend foundation — outputs/routes.ts
//
// Express routes for the manager-owned artifact review surface:
//
//   GET  /outputs/inbox                  — projection of artifacts the
//                                          operator needs to look at
//   GET  /artifacts/:id/review           — current review state for one
//                                          artifact (+ derived flags)
//   POST /artifacts/:id/view             — record an operator view
//   GET  /artifacts/:id/operations       — append-only op log for the
//                                          artifact
//   POST /artifacts/:id/approve          — operator approves
//   POST /artifacts/:id/ship             — operator ships (today returns
//                                          explicit blockers; same shape
//                                          will return status:"ok" when
//                                          executors land)
//
// All endpoints take/return JSON and use 400 for malformed request bodies,
// 404 for unknown artifacts on read endpoints, 500 for unexpected errors.

import type { Application, Request, Response } from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import {
  artifactIdFromPath,
  backfillCatalogFromDeliveryLog,
  countOperations,
  getArtifact,
  getReviewState,
  listInboxItems,
  listOperations,
  registerArtifact,
} from './storage.js';
import { approveArtifact, commentArtifact, listComments, shipArtifact, viewArtifact } from './ops.js';
import type {
  ApproveRequest,
  ArtifactAvailability,
  ArtifactOperationsResponse,
  ArtifactReviewResponse,
  OutputsInboxResponse,
  OutputsInboxRow,
  RegisterArtifactRequest,
  RegisterArtifactResponse,
  ShipRequest,
  ViewRequest,
} from './types.js';
import { normalizeActorRef, isValidArtifactId, type Actor } from '../actor-identity.js';
import type { TasksRepository } from '../db/db-service.js';
import { emitApprovalTask, type ApprovalReviewer } from './approval-emit.js';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Kapelle P3 (2026-06-09) — runtime deps for the manager-side approval
 * emit target. `tasks` is the manager's TasksRepository; `resolveTeamId`
 * is called per-request to map an Express Request to the team scope
 * that the emitted approval-task should belong to.
 *
 * Both are optional so existing tests + boot paths that don't yet have
 * the task seam can mount the routes unchanged. When omitted the
 * approve endpoint still records the operation + review state (the B11
 * canonical write); the response's `task` field is null and
 * `task_emit_skipped` is set so kapelle-site can show the operator
 * that the canonical emit chain didn't run.
 */
export interface MountOutputsRoutesOptions {
  tasks?: TasksRepository;
  resolveTeamId?: (req: Request) => Promise<string>;
}

export function mountOutputsRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountOutputsRoutesOptions = {},
): void {
  const { tasks, resolveTeamId } = opts;

  // Monday §1/§2 guards. RD-001: reject anything that isn't a stable artifact_id
  // (display id / basename / queue index / path) as a mutation target. Actor:
  // require one of the two fixed Monday actors. Both return typed 4xx errors and
  // signal the caller (via the returned null) to stop.
  function requireArtifactId(req: Request<{ id: string }>, res: Response): string | null {
    const id = req.params.id;
    if (!isValidArtifactId(id)) {
      res.status(400).json({
        ok: false,
        error: `invalid artifact id "${id}" — operations target a stable artifact_id, not a display id, basename, index, or path`,
        code: 'invalid_artifact_id',
      });
      return null;
    }
    return id;
  }
  function requireActor(req: Request, res: Response): Actor | null {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.actor_ref ?? body.actorRef ?? body.actor ?? body.approver ?? body.shipper ?? body.viewer;
    const result = normalizeActorRef(raw);
    if (!result.ok) {
      res.status(result.code === 'missing_actor' ? 400 : 403).json({
        ok: false,
        error: result.error,
        code: result.code,
      });
      return null;
    }
    return result.actor;
  }

  // ── GET /outputs/inbox ─────────────────────────────────────────────

  app.get('/outputs/inbox', async (req: Request, res: Response) => {
    try {
      const status = asString(req.query.status) as OutputsInboxRow['status'] | undefined;
      const agent = asString(req.query.agent);
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const items = await listInboxItems(
        adapter,
        { status, agent, includeNeverViewed: true },
        limit,
        offset,
      );

      const response: OutputsInboxResponse = {
        schema_version: 'outputs.inbox.v1',
        generated_at: new Date().toISOString(),
        items,
        limit,
        offset,
        count: items.length,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/review ──────────────────────────────────────

  app.get('/artifacts/:id/review', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = req.params.id;
      const state = await getReviewState(adapter, artifactId);
      const catalog = await getArtifact(adapter, artifactId);
      const operations_count = await countOperations(adapter, artifactId);

      const availability: ArtifactAvailability = catalog?.availability ?? 'unknown';

      const response: ArtifactReviewResponse = {
        schema_version: 'artifact.review.v1',
        artifact_id: artifactId,
        state,
        catalog,
        availability,
        operations_count,
        source_link: state?.source_link ?? null,
        is_viewed: !!state?.first_viewed_at,
        is_approved: !!state?.approved_at,
        is_shipped: !!state?.shipped_at,
        is_ship_blocked: !!state?.ship_blockers_json && !state?.shipped_at,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/register ───────────────────────────────────────
  // Catalog write surface. Called by:
  //   - /deliver path on /agent-done (live writes as artifacts land)
  //   - the delivery-log backfill helper
  //   - operators manually (e.g. when a Vetra-side doc-model entry needs
  //     to materialize in the manager's projection)
  //
  // Idempotent: identical re-POSTs are no-ops. Caller can omit artifact_id;
  // we derive it deterministically from abs_path.

  app.post('/artifacts/register', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const required = ['basename', 'agent', 'abs_path', 'produced_at'];
      const missing = required.filter(k => !body[k]);
      if (missing.length > 0) {
        res.status(400).json({ error: `missing fields: ${missing.join(', ')}` });
        return;
      }
      const payload: RegisterArtifactRequest = {
        artifact_id: typeof body.artifact_id === 'string' ? body.artifact_id : undefined,
        basename: String(body.basename),
        agent: String(body.agent),
        tag: typeof body.tag === 'string' ? body.tag : undefined,
        abs_path: String(body.abs_path),
        title: typeof body.title === 'string' ? body.title : undefined,
        produced_at: String(body.produced_at),
        source: body.source === 'delivery-log' || body.source === 'manual' ? body.source : 'agent-done',
        availability: body.availability === 'missing' || body.availability === 'unknown' ? body.availability : 'present',
      };
      const { row, inserted } = await registerArtifact(adapter, payload, new Date().toISOString());
      const response: RegisterArtifactResponse = {
        schema_version: 'artifact.register.v1',
        artifact_id: row.artifact_id,
        inserted,
        row,
      };
      res.json(response);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/catalog/backfill ───────────────────────────────
  // One-shot admin endpoint: caller POSTs the delivery-log text body; we
  // parse + upsert every row into the artifacts catalog. Idempotent.
  //
  // Request body shape:
  //   { delivery_log_text: "<full file contents>" }
  // Response:
  //   { schema_version: "artifact.catalog.backfill.v1", rows_seen, rows_parsed, inserted, updated, skipped }
  //
  // Intentionally text-in (not path-in) so the manager doesn't need
  // filesystem access into Dropbox; the operator's machine reads the
  // file and posts the contents.

  app.post('/artifacts/catalog/backfill', async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.delivery_log_text === 'string' ? req.body.delivery_log_text : '';
      if (!text) {
        res.status(400).json({ error: 'missing delivery_log_text' });
        return;
      }
      const result = await backfillCatalogFromDeliveryLog(adapter, text, new Date().toISOString());
      res.json({ schema_version: 'artifact.catalog.backfill.v1', ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/view ───────────────────────────────────────

  app.post('/artifacts/:id/view', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const reqBody: ViewRequest = {
        viewer: asString(req.body?.viewer),
        source_link: asString(req.body?.source_link),
      };
      const { state, op_id } = await viewArtifact(adapter, req.params.id, reqBody);
      res.json({ ok: true, state, op_id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/operations ──────────────────────────────────

  app.get('/artifacts/:id/operations', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const operations = await listOperations(adapter, req.params.id, limit, offset);

      const response: ArtifactOperationsResponse = {
        schema_version: 'artifact.operations.v1',
        artifact_id: req.params.id,
        operations,
        limit,
        offset,
        count: operations.length,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/comments ───────────────────────────────────
  // Monday §2: durable, append-only artifact comment. This is the unblock —
  // Chris (and now Liz) can comment on an artifact and it persists, re-readable
  // through /operations + /review. Requires a valid Monday actor + artifact_id.
  app.post('/artifacts/:id/comments', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const body = asString(req.body?.body);
      if (!body || body.trim().length === 0) {
        return res.status(400).json({ ok: false, error: 'comment body is required', code: 'missing_body' });
      }
      const { comment, op_id } = await commentArtifact(adapter, artifactId, {
        actor: actor.ref,
        body,
        anchor: asString(req.body?.anchor) ?? null,
        source_link: asString(req.body?.source_link),
      });
      res.json({ ok: true, schema_version: 'artifact.comment.v1', op_id, comment, actor });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/comments ────────────────────────────────────
  app.get('/artifacts/:id/comments', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const comments = await listComments(adapter, req.params.id, limit, offset);
      res.json({
        ok: true,
        schema_version: 'artifact.comments.v1',
        artifact_id: req.params.id,
        comments,
        count: comments.length,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/approve ────────────────────────────────────
  //
  // Kapelle P3 (2026-06-09): the canonical manager-side emit target.
  // Steps:
  //   1. approveArtifact() updates artifact_review_state + appends an
  //      artifact_operations row (existing B11 behavior).
  //   2. If a tasks repo + team resolver were injected at mount time,
  //      emitApprovalTask() creates the downstream manager task that
  //      carries the structured approval payload Regina's /ops
  //      decisions queue (OP-1) reads from.
  //   3. The response contains BOTH the review state and the
  //      created/idempotent task, or a structured task_emit_error if
  //      the task creation step failed. The approval itself never
  //      fails on task-emit failure — the operator can retry the
  //      whole call.

  app.post('/artifacts/:id/approve', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const reqBody: ApproveRequest = {
        approver: actor.ref, // durable Monday attribution: approved_by = user:chris|user:liz
        note: asString(req.body?.note),
        source_link: asString(req.body?.source_link),
      };
      const sourceSurface =
        asString(req.body?.source_surface) ?? asString(req.body?.source_link) ?? "manager:/artifacts/approve";
      const { state, op_id, idempotent } = await approveArtifact(adapter, artifactId, reqBody);

      // No tasks seam wired up → return the review state alone with an
      // explicit skip marker so kapelle-site can show the operator
      // that the emit chain wasn't run. This path is for bootstrap /
      // legacy mounts; production mounts ALWAYS provide tasks.
      if (!tasks || !resolveTeamId) {
        res.json({
          ok: true,
          state,
          op_id,
          idempotent,
          actor: actor.ref,
          task: null,
          task_emitted: false,
          task_emit_skipped: "manager_emit_target_not_configured",
        });
        return;
      }

      let teamId: string;
      try {
        teamId = await resolveTeamId(req);
      } catch (err) {
        res.json({
          ok: true,
          state,
          op_id,
          task: null,
          task_emitted: false,
          task_emit_error: {
            kind: "team_resolution",
            message: err instanceof Error ? err.message : String(err),
            retry_with: {
              method: "POST",
              url: `/artifacts/${artifactId}/approve`,
              body: { ...req.body },
            },
          },
        });
        return;
      }

      // Emit reviewer derives from the fixed Monday actor (kind human, the
      // operator's id), keeping the downstream approval-task attribution clean.
      const reviewer: ApprovalReviewer = { kind: "human", id: actor.id, label: actor.displayName };
      const emit = await emitApprovalTask({
        adapter,
        tasks,
        input: {
          artifact_id: artifactId,
          reviewer,
          approval_state: "approved",
          source_surface: sourceSurface,
          approved_at: state.approved_at ?? new Date().toISOString(),
          op_id,
          approval_note: reqBody.note ?? null,
          team_id: teamId,
        },
      });

      if (!emit.ok) {
        res.json({
          ok: true,
          state,
          op_id,
          task: null,
          task_emitted: false,
          task_emit_error: emit.error,
        });
        return;
      }

      res.json({
        ok: true,
        state,
        op_id,
        idempotent,
        actor: actor.ref,
        task: emit.task,
        task_emitted: true,
        task_idempotent: emit.idempotent,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/ship ───────────────────────────────────────

  app.post('/artifacts/:id/ship', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const reqBody: ShipRequest = {
        shipper: actor.ref, // durable Monday attribution on the ship attempt/blocker
        source_link: asString(req.body?.source_link),
      };
      const result = await shipArtifact(adapter, artifactId, reqBody);
      // 200 even when blocked — clients inspect status + blockers. Ship stays
      // visible-but-blocked (no_executor_configured) until a destination
      // executor exists; the attempt is recorded as a durable operation.
      res.json({ ...result, actor: actor.ref });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * P3: map a free-form approver string to the structured `reviewer`
 * shape the approval payload requires. Supported inputs:
 *
 *   "human:chris"    -> { kind: "human", id: "chris", label: "chris" }
 *   "agent:regina"   -> { kind: "agent", id: "regina", label: "regina" }
 *   "system:auto"    -> { kind: "system", id: "auto", label: "auto" }
 *   "chris"          -> { kind: "human", id: "chris", label: "chris" }
 *   undefined        -> { kind: "system", id: "operator", label: "operator" }
 *
 * Unknown prefixes fall back to `human`. The label is the id verbatim.
 */
function parseReviewer(raw: string | undefined): ApprovalReviewer {
  if (!raw) return { kind: "system", id: "operator", label: "operator" };
  const m = raw.match(/^(human|agent|system):(.+)$/);
  if (m && m[2]) {
    return {
      kind: m[1] as ApprovalReviewer["kind"],
      id: m[2],
      label: m[2],
    };
  }
  return { kind: "human", id: raw, label: raw };
}
