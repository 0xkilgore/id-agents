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
import { approveArtifact, shipArtifact, viewArtifact } from './ops.js';
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

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function mountOutputsRoutes(app: Application, adapter: DbAdapter): void {

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

  // ── POST /artifacts/:id/approve ────────────────────────────────────

  app.post('/artifacts/:id/approve', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const reqBody: ApproveRequest = {
        approver: asString(req.body?.approver),
        note: asString(req.body?.note),
        source_link: asString(req.body?.source_link),
      };
      const { state, op_id } = await approveArtifact(adapter, req.params.id, reqBody);
      res.json({ ok: true, state, op_id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/ship ───────────────────────────────────────

  app.post('/artifacts/:id/ship', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const reqBody: ShipRequest = {
        shipper: asString(req.body?.shipper),
        source_link: asString(req.body?.source_link),
      };
      const result = await shipArtifact(adapter, req.params.id, reqBody);
      // 200 even when blocked — clients inspect status + blockers.
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
