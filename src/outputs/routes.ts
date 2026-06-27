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
  appendOperation,
  backfillCatalogFromDeliveryLog,
  countOperations,
  getArtifact,
  getArtifactDraft,
  getReviewState,
  listArtifactCatalog,
  listInboxItems,
  listOperations,
  parseDraftPayload,
  registerArtifact,
  searchArtifacts,
  upsertArtifactDraft,
} from './storage.js';
import { planCorpusSearch } from '../corpus-search/lane.js';
import { artifactRowToEntry } from './entry-projection.js';
import { EDIT_OP_TYPE, buildEditPayload, isEditInProductEnabled, latestEdit } from './edit.js';
import { checkArtifactParity } from './parity.js';
import type { ArtifactEntry, ReadModelEnvelope } from './entry.js';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  approveArtifact,
  checkActionCooldown,
  commentArtifact,
  DEFAULT_ACTION_COOLDOWN_MS,
  listTimelineEvents,
  listComments,
  listFeedback,
  reactArtifact,
  recordCommentRouted,
  recordDispatchFollowUp,
  rejectArtifact,
  reviseDraft,
  shipArtifact,
  suggestArtifactChange,
  viewArtifact,
  type CaneDraftShipContext,
} from './ops.js';
import {
  isCaneDraftArtifactsEnabled,
  isC0FeedbackReactionsEnabled,
  useDocumentModel,
} from '../config/feature-flags.js';
import {
  defaultCaneDraftSender,
  pendingIdFromDraftId,
  type CaneDraftSender,
} from './ship-executor.js';
import type {
  ApproveRequest,
  ArtifactAvailability,
  ArtifactDetailResponse,
  ArtifactOperationsResponse,
  ArtifactOpType,
  ArtifactReviewResponse,
  ArtifactTimelineResponse,
  CaneDraftPayload,
  DispatchFollowUpRequest,
  OutputsInboxResponse,
  OutputsInboxRow,
  RegisterArtifactRequest,
  RegisterArtifactResponse,
  RejectRequest,
  ReactionRequest,
  ShipRequest,
  SuggestedChangeRequest,
  ViewRequest,
} from './types.js';
import { isReactionKind } from './types.js';
import { normalizeActorRef, isValidArtifactId, type Actor } from '../actor-identity.js';
import type { TasksRepository } from '../db/db-service.js';
import { emitApprovalTask, type ApprovalReviewer } from './approval-emit.js';
import {
  routeCommentToOwningAgent,
  type CommentDispatchEnqueueFn,
} from './comment-dispatch.js';
import {
  reconcileFilesystemArtifacts,
  type FilesystemArtifactRoot,
} from './filesystem-reconciler.js';
import {
  buildArtifactDetail,
  resolveArtifactDetailRef,
  type ArtifactDetailRef,
} from './detail-projection.js';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function idempotencyKey(req: Request, suffix?: string): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw =
    asString(body.idempotency_key) ??
    asString(body.idempotencyKey) ??
    asString(req.header('idempotency-key'));
  if (!raw) return null;
  return suffix ? `${raw}:${suffix}` : raw;
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
  filesystemArtifactRoots?: (req: Request) => Promise<FilesystemArtifactRoot[]>;
  filesystemReconcileRecentMs?: number;
  onFilesystemReconcileError?: (err: unknown) => void;
  /** T3B-1 per-(artifact,action,actor) cooldown in ms. Defaults to 3000. */
  actionCooldownMs?: number;
  /** Injectable clock for deterministic cooldown tests. */
  now?: () => Date;
  /**
   * B2 (2026-06-22): scheduler enqueue seam. When provided, a submitted
   * artifact comment is routed to the artifact's owning agent as a real
   * dispatch (the manager binds `dispatchScheduler.enqueue` here). When
   * omitted, comments still persist; the response carries `dispatch: null`
   * + `dispatch_skipped` so the console can show routing didn't run.
   */
  enqueueDispatch?: CommentDispatchEnqueueFn;
  /**
   * ARTIFACTS substrate proof-cut. Absolute path to delivery-log.md used by the
   * auto-ingest timer and the parity walk. Defaults to
   * ~/Dropbox/Code/cane/taskview/delivery-log.md.
   */
  deliveryLogPath?: string;
  /** Injectable delivery-log reader (tests). Returns null when the file is absent. */
  readDeliveryLog?: () => Promise<string | null>;
  /** Enable the background catalog auto-ingest timer. Default: !test runner && ARTIFACTS_AUTOINGEST != off. */
  autoIngest?: boolean;
  /** Auto-ingest interval (ms). Default 600_000 (10min). */
  autoIngestIntervalMs?: number;
  /** Env source for feature-flag / autoingest reads (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * CANE_DRAFT_ARTIFACTS — injectable Cane send executor. When provided, the
   * cane_draft ship path uses this instead of the default HTTP sender, so tests
   * never hit the network. Defaults to defaultCaneDraftSender(CANE_BASE_URL).
   */
  caneDraftSender?: CaneDraftSender;
}

/** C0: persist the feedback→dispatch linkage (comment_routed op) after a
 *  comment/reaction routes. Best-effort — a write failure here must NEVER fail
 *  the request: the durable feedback and the routing receipt already landed; the
 *  chip simply won't show this one dispatch's trace until the next interaction. */
async function persistRoutedLinkage(
  adapter: DbAdapter,
  artifactId: string,
  sourceOpId: number,
  dispatch: { dispatch_phid: string; query_id: string; to_agent: string },
  actor: string,
  clock?: () => Date,
): Promise<void> {
  try {
    await recordCommentRouted(
      adapter,
      artifactId,
      {
        source_op_id: sourceOpId,
        dispatch_phid: dispatch.dispatch_phid,
        query_id: dispatch.query_id,
        to_agent: dispatch.to_agent,
      },
      actor,
      clock,
    );
  } catch {
    /* swallow — durable capture + receipt already succeeded */
  }
}

export function mountOutputsRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountOutputsRoutesOptions = {},
): void {
  const { tasks, resolveTeamId } = opts;
  const cooldownMs = opts.actionCooldownMs ?? DEFAULT_ACTION_COOLDOWN_MS;
  const clock = opts.now;
  // CANE_DRAFT_ARTIFACTS — resolve the send executor once. Injectable for tests.
  const caneDraftSender: CaneDraftSender =
    opts.caneDraftSender ?? defaultCaneDraftSender();

  // ── ARTIFACTS substrate proof-cut: delivery-log seam + parity cache ──
  const env = opts.env ?? process.env;
  const deliveryLogPath =
    opts.deliveryLogPath ?? join(homedir(), 'Dropbox', 'Code', 'cane', 'taskview', 'delivery-log.md');
  const readDeliveryLog =
    opts.readDeliveryLog ??
    (async (): Promise<string | null> => {
      try {
        return await fsp.readFile(deliveryLogPath, 'utf8');
      } catch {
        return null;
      }
    });
  // Last-known parity status, surfaced on the /artifacts/entries envelope so the
  // console can render it without the entries handler touching the filesystem.
  let lastParityStatus: ReadModelEnvelope<unknown>['parity']['status'] = 'unchecked';
  const detailCache = new Map<string, ArtifactDetailResponse>();
  const detailInflight = new Map<string, Promise<ArtifactDetailResponse | null>>();
  const detailCacheMax = 100;

  function invalidateArtifactDetail(artifactId: string): void {
    detailCache.delete(artifactId);
    detailInflight.delete(artifactId);
  }

  function clearArtifactDetailCache(): void {
    detailCache.clear();
    detailInflight.clear();
  }

  function rememberArtifactDetail(detail: ArtifactDetailResponse): void {
    if (detailCache.has(detail.artifact_id)) detailCache.delete(detail.artifact_id);
    detailCache.set(detail.artifact_id, detail);
    while (detailCache.size > detailCacheMax) {
      const oldest = detailCache.keys().next().value;
      if (!oldest) break;
      detailCache.delete(oldest);
    }
  }

  async function getArtifactDetailCached(ref: ArtifactDetailRef): Promise<{
    detail: ArtifactDetailResponse | null;
    cache: 'hit' | 'miss' | 'deduped';
  }> {
    const hit = detailCache.get(ref.artifactId);
    if (hit) return { detail: hit, cache: 'hit' };
    const existing = detailInflight.get(ref.artifactId);
    if (existing) return { detail: await existing, cache: 'deduped' };
    const pending = buildArtifactDetail(adapter, ref);
    detailInflight.set(ref.artifactId, pending);
    try {
      const detail = await pending;
      if (detail) rememberArtifactDetail(detail);
      return { detail, cache: 'miss' };
    } finally {
      detailInflight.delete(ref.artifactId);
    }
  }

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
  // T3B-1 cooldown guard: blocks an actor repeating the same action on an
  // artifact within the cooldown window (anti double-click). Per-actor, so a
  // Chris-then-Liz multi-operator flow is never blocked. Returns true (and
  // sends 429) when the request should stop.
  async function cooldownBlocked(
    artifactId: string,
    opTypes: ArtifactOpType[],
    actorRef: string,
    res: Response,
  ): Promise<boolean> {
    const c = await checkActionCooldown(adapter, artifactId, opTypes, actorRef, cooldownMs, clock);
    if (c.blocked) {
      res.status(429).json({
        ok: false,
        code: 'action_cooldown',
        error: `action on cooldown for ${actorRef}; retry in ${c.retry_after_ms}ms`,
        retry_after_ms: c.retry_after_ms,
        last_action_at: c.last_ts,
      });
      return true;
    }
    return false;
  }

  // ── POST /artifacts/reconcile ──────────────────────────────────────
  // T11.6 on-demand reconcile: catalog artifacts across all configured roots
  // (project root + output/drafts/… ) and run the missing-sweep. A FULL scan by
  // default (the findability fix — "I can't find the one-pager"); pass
  // ?recent_ms=N to limit to recently-modified files.
  app.post('/artifacts/reconcile', async (req: Request, res: Response) => {
    try {
      if (!opts.filesystemArtifactRoots) {
        return res.status(503).json({ ok: false, error: 'filesystem_reconcile_not_configured' });
      }
      const roots = await opts.filesystemArtifactRoots(req);
      const recentMs = parseInt(asString(req.query.recent_ms) ?? '', 10);
      const result = await reconcileFilesystemArtifacts(adapter, {
        roots,
        recentSinceMs: Number.isFinite(recentMs) && recentMs > 0 ? Date.now() - recentMs : undefined,
      });
      clearArtifactDetailCache();
      res.json({ ok: true, schema_version: 'artifact.reconcile.v1', result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /outputs/inbox ─────────────────────────────────────────────

  app.get('/outputs/inbox', async (req: Request, res: Response) => {
    try {
      const status = asString(req.query.status) as OutputsInboxRow['status'] | undefined;
      const agent = asString(req.query.agent);
      const kind = asString(req.query.kind) === 'cane_draft' ? 'cane_draft' as const : undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      if (opts.filesystemArtifactRoots && !useDocumentModel('artifacts', env)) {
        try {
          const roots = await opts.filesystemArtifactRoots(req);
          await reconcileFilesystemArtifacts(adapter, {
            roots,
            recentSinceMs: Date.now() - (opts.filesystemReconcileRecentMs ?? 24 * 60 * 60 * 1000),
          });
        } catch (err) {
          opts.onFilesystemReconcileError?.(err);
        }
      }

      const items = await listInboxItems(
        adapter,
        { status, agent, kind, includeNeverViewed: true },
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

  // ── GET /artifacts/entries ─────────────────────────────────────────
  // ARTIFACTS substrate proof-cut (Step 2). Reads the artifacts feed from the
  // SQL substrate (no filesystem access in this handler) and returns the shared
  // read-model envelope with ArtifactEntry[] (DV1 shape) + DV2 provenance.
  app.get('/artifacts/entries', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const agent = asString(req.query.agent);
      const tag = asString(req.query.tag);
      const since = asString(req.query.since);

      const rows = await listArtifactCatalog(adapter, { limit, offset, agent, tag, since });
      const items: ArtifactEntry[] = [];
      for (const row of rows) {
        const [review, ops] = await Promise.all([
          getReviewState(adapter, row.artifact_id),
          listOperations(adapter, row.artifact_id, 50, 0),
        ]);
        items.push(artifactRowToEntry(row, review, ops));
      }

      const envelope: ReadModelEnvelope<ArtifactEntry> = {
        schema_version: 'read-model.v1',
        generated_at: new Date().toISOString(),
        items,
        count: items.length,
        limit,
        offset,
        source: { read_path: 'substrate', projection: 'artifact_entries' },
        parity: { status: lastParityStatus },
      };
      res.json(envelope);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/entries/:ref ────────────────────────────────────
  // DV2 (I-1): the single doc-model ArtifactEntry (with provenance —
  // actor_ref/source_dispatch/derived_from/revision-chain) for ONE artifact, so
  // provenance is queryable PER ENTRY, symmetric with GET /tasks/entries/:ref —
  // not only embedded in the list feed. Registered before the '/artifacts/:id/*'
  // routes so the literal 'entries' segment isn't captured as an :id.
  app.get('/artifacts/entries/:ref', async (req: Request<{ ref: string }>, res: Response) => {
    try {
      const id = req.params.ref;
      const row = await getArtifact(adapter, id);
      if (!row) return res.status(404).json({ error: `Artifact "${id}" not found` });
      const [review, ops] = await Promise.all([
        getReviewState(adapter, row.artifact_id),
        listOperations(adapter, row.artifact_id, 50, 0),
      ]);
      res.json({ entry: artifactRowToEntry(row, review, ops) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/search ──────────────────────────────────────────
  // L-1/L-2 full-text search over the doc-model substrate (SQLite FTS5). Ranks
  // artifacts by bm25 relevance to ?q= and returns the SAME read-model envelope
  // as /artifacts/entries (ArtifactEntry[] + DV2 provenance), in rank order.
  // Registered before the '/artifacts/:id/*' routes so 'search' isn't an :id.
  app.get('/artifacts/search', async (req: Request, res: Response) => {
    try {
      const q = asString(req.query.q) ?? '';
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      // T-CKPT.corpus-search — lane guard. Internal corpus queries run on the
      // local FTS5 index; a web/external-scoped query (web:/site:/URL) is NOT
      // silently run through FTS — it 400s until a web provider is wired (per the
      // Exa review: keep the internal + external lanes separate). An empty query
      // keeps its existing behavior (falls through to an empty result set).
      const plan = planCorpusSearch(q);
      if (!plan.ok && plan.reason === 'external_lane_disabled') {
        return res.status(400).json({ error: plan.error, lane: plan.lane, reason: plan.reason });
      }
      const searchQuery = plan.ok ? plan.query : q;

      const rows = await searchArtifacts(adapter, searchQuery, { limit, offset });
      const items: ArtifactEntry[] = [];
      for (const row of rows) {
        const [review, ops] = await Promise.all([
          getReviewState(adapter, row.artifact_id),
          listOperations(adapter, row.artifact_id, 50, 0),
        ]);
        items.push(artifactRowToEntry(row, review, ops));
      }

      const envelope: ReadModelEnvelope<ArtifactEntry> = {
        schema_version: 'read-model.v1',
        generated_at: new Date().toISOString(),
        items, // already in bm25 rank order (best first)
        count: items.length,
        limit,
        offset,
        source: { read_path: 'substrate', projection: 'artifact_search' },
        parity: { status: lastParityStatus },
      };
      res.json(envelope);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/parity ──────────────────────────────────────────
  // ARTIFACTS substrate proof-cut (Step 3). Compares the substrate projection
  // against a delivery-log.md walk on the do-not-break metrics. The flag flip is
  // BLOCKED unless this returns status:"ok". Caches the status for the entries
  // envelope.
  app.get('/artifacts/parity', async (_req: Request, res: Response) => {
    try {
      const text = await readDeliveryLog();
      if (text == null) {
        res.json({
          status: 'drift',
          generated_at: new Date().toISOString(),
          substrate_count: 0,
          delivery_log_count: 0,
          metrics: [],
          drift: ['delivery-log.md is not readable; cannot confirm parity'],
        });
        return;
      }
      const report = await checkArtifactParity(adapter, text, new Date().toISOString());
      lastParityStatus = report.status;
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function sendArtifactDetail(ref: ArtifactDetailRef, res: Response): Promise<void> {
    const { detail, cache } = await getArtifactDetailCached(ref);
    res.setHeader('X-Artifact-Detail-Cache', cache);
    if (!detail) {
      res.status(404).json({
        ok: false,
        code: 'artifact_not_found',
        error: `Artifact "${ref.requestedRef}" not found`,
        artifact_id: ref.artifactId,
      });
      return;
    }
    res.json(detail);
  }

  // ── GET /artifacts/detail?path=<encoded-or-plain-path> ─────────────
  // Bounded single-artifact read model for instant reader pane switching. This
  // query route preserves the legacy encoded-path fallback while the stable-id
  // route below is the preferred cache key.
  app.get('/artifacts/detail', async (req: Request, res: Response) => {
    try {
      const ref = asString(req.query.path) ?? asString(req.query.ref) ?? asString(req.query.id);
      if (!ref) return res.status(400).json({ ok: false, code: 'missing_ref', error: 'path, ref, or id is required' });
      await sendArtifactDetail(resolveArtifactDetailRef(ref), res);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/detail ─────────────────────────────────────
  // One request hydrates body/render metadata, compact catalog fields, review
  // summary, comments/timeline, and provenance for the center reader pane.
  app.get('/artifacts/:id/detail', async (req: Request<{ id: string }>, res: Response) => {
    try {
      await sendArtifactDetail(resolveArtifactDetailRef(req.params.id), res);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
      invalidateArtifactDetail(row.artifact_id);
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

  // ── POST /drafts (CANE_DRAFT_ARTIFACTS) ────────────────────────────
  // Cane's dual-write target: register a needs_approval Cane draft as a
  // cane_draft artifact (catalog row + typed payload side-table). Idempotent on
  // draft_id — a re-poll updates in place, never duplicates. Flag-gated: 404
  // when CANE_DRAFT_ARTIFACTS is OFF (so the legacy state.json flow is the only
  // surface until piloted). The artifact_id is derived deterministically from
  // draft_id so all writers converge on one id per draft.
  app.post('/drafts', async (req: Request, res: Response) => {
    try {
      if (!isCaneDraftArtifactsEnabled(env)) {
        return res.status(404).json({ ok: false, error: 'cane_draft_artifacts_disabled' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const draftId = asString(body.draft_id);
      if (!draftId || !draftId.startsWith('cane:draft:')) {
        return res.status(400).json({ ok: false, error: 'draft_id "cane:draft:<pending_id>" is required' });
      }
      if (body.send_recommendation !== 'needs_approval') {
        // Scope guard: only needs_approval drafts become artifacts. Auto-send-
        // eligible drafts are out of scope and must not be registered.
        return res.status(400).json({ ok: false, error: 'only send_recommendation="needs_approval" drafts are registered' });
      }
      const channel = body.channel === 'telegram' ? 'telegram' : 'email';
      const payload: CaneDraftPayload = {
        draft_id: draftId,
        channel,
        to: asString(body.to) ?? '',
        subject: asString(body.subject) ?? '',
        body_markdown: typeof body.body_markdown === 'string' ? body.body_markdown : '',
        in_reply_to: asString(body.in_reply_to) ?? null,
        references: asString(body.references) ?? null,
        source_inbox_ref: asString(body.source_inbox_ref) ?? null,
        send_recommendation: 'needs_approval',
        reasoning: asString(body.reasoning) ?? null,
        revision_history: [],
      };
      const artifactId = artifactIdFromPath(draftId);
      const nowIso = (clock?.() ?? new Date()).toISOString();
      // Idempotent: a re-register preserves the existing revision_history so an
      // operator edit isn't clobbered by a later re-poll of the same draft.
      const existingDraft = parseDraftPayload(await getArtifactDraft(adapter, artifactId));
      if (existingDraft) {
        payload.revision_history = existingDraft.revision_history ?? [];
      }
      const { inserted: catalogInserted } = await registerArtifact(
        adapter,
        {
          artifact_id: artifactId,
          basename: `${draftId}.draft`,
          agent: 'cane',
          tag: 'cane_draft',
          abs_path: draftId,
          title: payload.subject || `Cane draft to ${payload.to}`,
          produced_at: nowIso,
          source: 'agent-done',
          availability: 'present',
        },
        nowIso,
      );
      const { inserted: draftInserted } = await upsertArtifactDraft(adapter, artifactId, payload, nowIso);
      invalidateArtifactDetail(artifactId);
      res.json({
        ok: true,
        schema_version: 'cane.draft.register.v1',
        artifact_id: artifactId,
        draft_id: draftId,
        source_link: draftId,
        inserted: catalogInserted && draftInserted,
        payload,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/revise (CANE_DRAFT_ARTIFACTS) ──────────────
  // An operator's in-place rewrite of a cane_draft body — the spec's "Edit"
  // action. Distinct from POST /artifacts/:id/edit (generic edit op): this is a
  // `revise_draft` op that mutates the typed draft payload and appends to
  // revision_history. Flag-gated: 404 when CANE_DRAFT_ARTIFACTS is OFF (mirrors
  // the edit route's flag-gating).
  app.post('/artifacts/:id/revise', async (req: Request<{ id: string }>, res: Response) => {
    try {
      if (!isCaneDraftArtifactsEnabled(env)) {
        return res.status(404).json({ ok: false, error: 'cane_draft_artifacts_disabled' });
      }
      const bodyMarkdown = req.body?.body_markdown;
      if (typeof bodyMarkdown !== 'string') {
        return res.status(400).json({ ok: false, error: 'body_markdown (string) is required' });
      }
      const draftRow = await getArtifactDraft(adapter, req.params.id);
      if (!parseDraftPayload(draftRow)) {
        return res.status(404).json({ ok: false, error: 'no cane_draft for this artifact' });
      }
      const actor = asString(req.body?.actor) ?? 'user:operator';
      const { payload, op_id } = await reviseDraft(adapter, req.params.id, bodyMarkdown, actor, clock);
      invalidateArtifactDetail(req.params.id);
      res.json({ ok: true, schema_version: 'artifact.revise.v1', op_id, payload });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
      clearArtifactDetailCache();
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
      invalidateArtifactDetail(req.params.id);
      res.json({ ok: true, state, op_id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/edit (T-CKPT.8 edit-in-product, phase 1) ────
  // Capture an operator's in-place edit as an append-only `edit` op. The source
  // FILE IS NEVER MUTATED here — the edited body lives only in the substrate, so
  // the change is fully reversible. Flag-gated (ARTIFACTS_EDIT_IN_PRODUCT): a
  // no-op (404) until explicitly enabled.
  app.post('/artifacts/:id/edit', async (req: Request<{ id: string }>, res: Response) => {
    try {
      if (!isEditInProductEnabled(env)) {
        return res.status(404).json({ error: 'edit_in_product_disabled' });
      }
      const content = req.body?.content;
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content (string) is required' });
      }
      const actor = asString(req.body?.actor) ?? 'user:operator';
      const note = asString(req.body?.note) ?? null;
      const nowIso = (clock?.() ?? new Date()).toISOString();
      const op_id = await appendOperation(
        adapter,
        req.params.id,
        EDIT_OP_TYPE,
        actor,
        nowIso,
        buildEditPayload(content, note),
        'manager:/artifacts/edit',
      );
      invalidateArtifactDetail(req.params.id);
      res.json({ ok: true, op_id, edited_at: nowIso });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/edit ────────────────────────────────────────
  // The latest in-product edit (substrate-only) so the console can render the
  // operator's edited body over the file. Reads are always available.
  app.get('/artifacts/:id/edit', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const ops = await listOperations(adapter, req.params.id, 500, 0);
      res.json({ ok: true, edit: latestEdit(ops) });
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

  // ── GET /artifacts/:id/timeline ───────────────────────────────────
  // Artifact Review v1 read contract: typed, durable timeline events projected
  // from artifact_operations. This is the bounded API for reload-safe review
  // state; legacy /operations remains available unchanged.
  app.get('/artifacts/:id/timeline', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const events = await listTimelineEvents(adapter, req.params.id, limit, offset);
      const response: ArtifactTimelineResponse = {
        ok: true,
        schema_version: 'artifact.timeline.v1',
        artifact_id: req.params.id,
        events,
        limit,
        offset,
        count: events.length,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/timeline ──────────────────────────────────
  // Bounded event-write surface for the Artifact Review timeline. General
  // comments/approve/reject/view keep their legacy endpoints; this endpoint
  // adds typed suggested-change comments and follow-up dispatch receipts.
  app.post('/artifacts/:id/timeline', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const kind = asString(req.body?.kind) ?? asString(req.body?.event_kind);
      if (kind === 'suggested_change') {
        const body = asString(req.body?.body) ?? asString(req.body?.markdown);
        if (!body || body.trim().length === 0) {
          return res.status(400).json({ ok: false, error: 'suggested change body is required', code: 'missing_body' });
        }
        const status = asString(req.body?.status);
        if (status && !['open', 'applied', 'dismissed'].includes(status)) {
          return res.status(400).json({ ok: false, error: 'invalid suggested change status', code: 'invalid_status' });
        }
        const reqBody: SuggestedChangeRequest = {
          actor: actor.ref,
          body,
          anchor: asString(req.body?.anchor) ?? null,
          suggested_markdown: asString(req.body?.suggested_markdown) ?? asString(req.body?.suggestedMarkdown) ?? null,
          status: status as SuggestedChangeRequest['status'],
          source_link: asString(req.body?.source_link),
          idempotency_key: idempotencyKey(req),
        };
        const result = await suggestArtifactChange(adapter, artifactId, reqBody, clock);
        invalidateArtifactDetail(artifactId);
        return res.json({
          ok: true,
          schema_version: 'artifact.timeline.write.v1',
          event: result.event,
          op_id: result.op_id,
          idempotent: result.idempotent,
        });
      }
      if (kind === 'dispatch_follow_up') {
        const reqBody: DispatchFollowUpRequest = {
          actor: actor.ref,
          body: asString(req.body?.body) ?? null,
          target_agent: asString(req.body?.target_agent) ?? asString(req.body?.to_agent) ?? null,
          query_id: asString(req.body?.query_id) ?? null,
          dispatch_phid: asString(req.body?.dispatch_phid) ?? asString(req.body?.dispatch_id) ?? null,
          status: asString(req.body?.status) ?? null,
          source_link: asString(req.body?.source_link),
          idempotency_key: idempotencyKey(req),
        };
        const result = await recordDispatchFollowUp(adapter, artifactId, reqBody, clock);
        invalidateArtifactDetail(artifactId);
        return res.json({
          ok: true,
          schema_version: 'artifact.timeline.write.v1',
          event: result.event,
          op_id: result.op_id,
          idempotent: result.idempotent,
        });
      }
      return res.status(400).json({
        ok: false,
        code: 'invalid_timeline_event_kind',
        error: 'kind must be one of: suggested_change, dispatch_follow_up',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
        idempotency_key: idempotencyKey(req),
      });

      // B2 (2026-06-22): close the loop — route the now-durable comment to the
      // artifact's owning agent as a real dispatch. The comment is already
      // persisted above, so routing failures NEVER fail this request; they
      // surface as dispatch:null + a typed skip/error the console can show.
      const routed = await routeCommentToOwningAgent({
        adapter,
        enqueue: opts.enqueueDispatch,
        artifactId,
        comment,
      });

      // C0 close-the-loop: persist the feedback→dispatch linkage durably so the
      // acted-upon chip survives reloads. Flag-gated and best-effort — it never
      // affects the comment capture or the routing receipt. (Without the flag,
      // this endpoint behaves exactly as B2 shipped it.)
      if (routed.routed && isC0FeedbackReactionsEnabled(env)) {
        await persistRoutedLinkage(adapter, artifactId, op_id, routed.dispatch, actor.ref, clock);
      }

      invalidateArtifactDetail(artifactId);
      const base = { ok: true, schema_version: 'artifact.comment.v1', op_id, comment, actor };
      if (routed.routed) {
        res.json({ ...base, dispatch_routed: true, dispatch: routed.dispatch });
      } else if ('skipped' in routed) {
        res.json({ ...base, dispatch_routed: false, dispatch: null, dispatch_skipped: routed.skipped });
      } else {
        res.json({ ...base, dispatch_routed: false, dispatch: null, dispatch_error: routed.error });
      }
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

  // ── POST /artifacts/:id/reactions (C0_FEEDBACK_REACTIONS) ──────────
  // The lowest-click feedback surface (chris-feedback-system-design §3 C0): a
  // one-tap reaction (👍 ship_it / 👎 wrong / ❓ explain / 🔁 iterate) + an
  // optional one-sentence note. A reaction is a `comment_recorded` op carrying a
  // `reaction` field, so it rides the EXISTING comment listing and the EXISTING
  // comment-auto-dispatch (T-CKPT.7) — it never duplicates the routing path.
  // Flag-gated: 404 when C0_FEEDBACK_REACTIONS is OFF (mirrors the revise/edit
  // routes). Capture is durable first; routing failures degrade to typed markers.
  app.post('/artifacts/:id/reactions', async (req: Request<{ id: string }>, res: Response) => {
    try {
      if (!isC0FeedbackReactionsEnabled(env)) {
        return res.status(404).json({ ok: false, error: 'c0_feedback_reactions_disabled' });
      }
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const reaction = req.body?.reaction;
      if (!isReactionKind(reaction)) {
        return res.status(400).json({
          ok: false,
          code: 'invalid_reaction',
          error: 'reaction must be one of: ship_it, wrong, explain, iterate',
        });
      }
      const reqBody: ReactionRequest = {
        actor: actor.ref,
        reaction,
        note: asString(req.body?.note) ?? null,
        anchor: asString(req.body?.anchor) ?? null,
        source_link: asString(req.body?.source_link),
      };
      const { comment, op_id } = await reactArtifact(adapter, artifactId, reqBody, clock);

      // Same routing path as comments — the owning agent gets a real dispatch.
      const routed = await routeCommentToOwningAgent({
        adapter,
        enqueue: opts.enqueueDispatch,
        artifactId,
        comment,
      });
      if (routed.routed) {
        await persistRoutedLinkage(adapter, artifactId, op_id, routed.dispatch, actor.ref, clock);
      }

      invalidateArtifactDetail(artifactId);
      const base = { ok: true, schema_version: 'artifact.reaction.v1', op_id, comment, reaction, actor };
      if (routed.routed) {
        res.json({ ...base, dispatch_routed: true, dispatch: routed.dispatch });
      } else if ('skipped' in routed) {
        res.json({ ...base, dispatch_routed: false, dispatch: null, dispatch_skipped: routed.skipped });
      } else {
        res.json({ ...base, dispatch_routed: false, dispatch: null, dispatch_error: routed.error });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /artifacts/:id/feedback (C0_FEEDBACK_REACTIONS) ────────────
  // The acted-upon chip's read model: every reaction/comment on the artifact,
  // each annotated with the dispatch it fired, plus a rolled-up acted_upon
  // summary {state: none|captured|routed, …}. Derived purely from the op log.
  // Flag-gated: 404 when OFF.
  app.get('/artifacts/:id/feedback', async (req: Request<{ id: string }>, res: Response) => {
    try {
      if (!isC0FeedbackReactionsEnabled(env)) {
        return res.status(404).json({ ok: false, error: 'c0_feedback_reactions_disabled' });
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 500);
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const { items, acted_upon } = await listFeedback(adapter, req.params.id, limit, offset);
      res.json({
        ok: true,
        schema_version: 'artifact.feedback.v1',
        artifact_id: req.params.id,
        acted_upon,
        items,
        count: items.length,
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
      // Cooldown guards a non-idempotent rapid action (e.g. an approve→reject
      // flip-flop). A harmless idempotent re-approve bypasses it and returns the
      // current state.
      const preApprove = await getReviewState(adapter, artifactId);
      if (preApprove?.approved_at == null && (await cooldownBlocked(artifactId, ['approve', 'reject'], actor.ref, res))) return;
      const reqBody: ApproveRequest = {
        approver: actor.ref, // durable Monday attribution: approved_by = user:chris|user:liz
        note: asString(req.body?.note),
        source_link: asString(req.body?.source_link),
        idempotency_key: idempotencyKey(req, 'approval'),
      };
      const sourceSurface =
        asString(req.body?.source_surface) ?? asString(req.body?.source_link) ?? "manager:/artifacts/approve";
      const approvalCommentBody =
        asString(req.body?.comment) ??
        asString(req.body?.comment_body) ??
        asString(req.body?.approval_comment);
      const approvalComment = approvalCommentBody && approvalCommentBody.trim().length > 0
        ? await commentArtifact(adapter, artifactId, {
            actor: actor.ref,
            body: approvalCommentBody,
            anchor: asString(req.body?.anchor) ?? null,
            source_link: asString(req.body?.source_link),
            idempotency_key: idempotencyKey(req, 'comment'),
          }, clock)
        : null;
      const { state, op_id, idempotent } = await approveArtifact(adapter, artifactId, reqBody, clock);
      invalidateArtifactDetail(artifactId);

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
          comment: approvalComment?.comment ?? null,
          comment_op_id: approvalComment?.op_id ?? null,
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
          comment: approvalComment?.comment ?? null,
          comment_op_id: approvalComment?.op_id ?? null,
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
          comment: approvalComment?.comment ?? null,
          comment_op_id: approvalComment?.op_id ?? null,
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
        comment: approvalComment?.comment ?? null,
        comment_op_id: approvalComment?.op_id ?? null,
        task: emit.task,
        task_emitted: true,
        task_idempotent: emit.idempotent,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/reject ─────────────────────────────────────
  // T3B-1: the reject counterpart to approve. Durable, idempotent
  // (first-reject-wins), Monday-actor-attributed, cooldown-guarded.
  app.post('/artifacts/:id/reject', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      const preReject = await getReviewState(adapter, artifactId);
      if (preReject?.rejected_at == null && (await cooldownBlocked(artifactId, ['approve', 'reject'], actor.ref, res))) return;
      const reqBody: RejectRequest = {
        rejecter: actor.ref, // durable Monday attribution: rejected_by = user:chris|user:liz
        note: asString(req.body?.note),
        source_link: asString(req.body?.source_link),
      };
      const { state, op_id, idempotent } = await rejectArtifact(adapter, artifactId, reqBody, clock);
      invalidateArtifactDetail(artifactId);
      res.json({
        ok: true,
        schema_version: 'artifact.reject.v1',
        state,
        op_id,
        idempotent,
        actor: actor.ref,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /artifacts/:id/ship ───────────────────────────────────────

  app.post('/artifacts/:id/ship', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const artifactId = requireArtifactId(req, res);
      if (!artifactId) return;
      const actor = requireActor(req, res);
      if (!actor) return;
      if (await cooldownBlocked(artifactId, ['ship_attempted', 'ship_blocked'], actor.ref, res)) return;
      const reqBody: ShipRequest = {
        shipper: actor.ref, // durable Monday attribution on the ship attempt/blocker
        source_link: asString(req.body?.source_link),
      };
      // CANE_DRAFT_ARTIFACTS: when the flag is ON and this artifact is a
      // cane_draft, inject the send executor so ship actually sends the latest
      // body via the single Cane send path. For every other kind (or flag OFF),
      // no context is passed → shipArtifact returns no_executor_configured.
      let caneDraftCtx: CaneDraftShipContext | undefined;
      if (isCaneDraftArtifactsEnabled(env)) {
        const payload = parseDraftPayload(await getArtifactDraft(adapter, artifactId));
        if (payload) {
          const ops = await listOperations(adapter, artifactId, 500, 0);
          caneDraftCtx = { payload, ops, sender: caneDraftSender };
        }
      }
      const result = await shipArtifact(adapter, artifactId, reqBody, clock, caneDraftCtx);
      invalidateArtifactDetail(artifactId);
      // 200 even when blocked — clients inspect status + blockers. Non-cane_draft
      // ship stays visible-but-blocked (no_executor_configured); the attempt is
      // recorded as a durable operation.
      res.json({ ...result, actor: actor.ref });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── ARTIFACTS auto-ingest timer (Step 2) ───────────────────────────
  // Keep the catalog projection backed by the live delivery-log.md without a
  // manual backfill POST. Mirrors the decisions auto-ingest pattern: 5s warmup +
  // 10min interval, both .unref()'d, gated on ARTIFACTS_AUTOINGEST and never run
  // under the test runner. Re-ingests only when delivery-log.md's mtime changed,
  // so markdown stays canonical while the projection stays fresh. Opportunistically
  // refreshes the cached parity status after each ingest.
  const autoIngestEnabled =
    opts.autoIngest ??
    (typeof process.env.VITEST === 'undefined' &&
      !/^(0|false|no|off)$/i.test(env.ARTIFACTS_AUTOINGEST ?? ''));
  if (autoIngestEnabled) {
    const intervalMs = opts.autoIngestIntervalMs ?? 600_000;
    let lastMtimeMs = -1;
    const runIngest = async (): Promise<void> => {
      try {
        const stat = await fsp.stat(deliveryLogPath).catch(() => null);
        if (!stat) return;
        if (stat.mtimeMs === lastMtimeMs) return; // unchanged since last ingest
        lastMtimeMs = stat.mtimeMs;
        const text = await readDeliveryLog();
        if (text == null) return;
        const r = await backfillCatalogFromDeliveryLog(adapter, text, new Date().toISOString());
        try {
          lastParityStatus = (await checkArtifactParity(adapter, text)).status;
        } catch {
          /* keep last-known parity status */
        }
        if (r.inserted || r.updated) {
          clearArtifactDetailCache();
          console.log(
            `[artifacts] auto-ingest ${deliveryLogPath}: +${r.inserted}/${r.updated} (parsed ${r.rows_parsed})`,
          );
        }
      } catch (err) {
        console.warn(`[artifacts] auto-ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    setTimeout(() => void runIngest(), 5_000).unref?.();
    const timer = setInterval(() => void runIngest(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
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
