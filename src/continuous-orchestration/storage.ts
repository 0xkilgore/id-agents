// Continuous Orchestration — sqlite persistence.
//
// CRUD for the backlog, the append-only decision log, and the singleton
// per-team orchestration state. Pure SQL over the shared DbAdapter; the daemon
// + routes layer the policy on top.

import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import { normalizeRuntime, resolveProviderFromRuntime } from "../dispatch-scheduler/types.js";
import type {
  BacklogItem,
  DecisionRecord,
  FleshPatch,
  FleshStatus,
  OrchestrationMode,
  ReadinessState,
  RiskClass,
  StaleDuplicateCloseoutReceipt,
} from "./types.js";
import { extractRegisterIds } from "./register-id-extraction.js";

interface BacklogRow {
  item_id: string;
  team_id: string;
  logical_key: string | null;
  title: string;
  track: string | null;
  to_agent: string | null;
  dispatch_body: string | null;
  priority: number;
  value_score: number | null;
  readiness_state: string;
  risk_class: string;
  write_scope_json: string;
  dependencies_json: string;
  token_estimate: number | null;
  provider: string | null;
  runtime: string | null;
  is_north_star: number;
  source_refs_json: string;
  approved_by: string | null;
  approved_at: string | null;
  last_dispatch_phid: string | null;
  retry_safe: number | null;
  retry_safe_actor: string | null;
  retry_safe_reason: string | null;
  retry_safe_marked_at: string | null;
  dispatch_retry_count: number | null;
  stale_duplicate_closeout_receipt_json: string | null;
  updated_by: string | null;
  track_drift: number | null;
  flesh_status: string | null;
  flesh_source: string | null;
  flesh_confidence: number | null;
  flesh_error: string | null;
  flesh_attempts: number | null;
  fleshed_at: string | null;
  auto_ready_approved_at: string | null;
  auto_ready_policy_version: string | null;
  flesh_patch_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function rowToBacklogItem(r: BacklogRow): BacklogItem {
  return {
    item_id: r.item_id,
    team_id: r.team_id,
    logical_key: r.logical_key ?? null,
    title: r.title,
    track: r.track,
    to_agent: r.to_agent,
    dispatch_body: r.dispatch_body,
    priority: r.priority,
    value_score: r.value_score,
    readiness_state: r.readiness_state as ReadinessState,
    risk_class: r.risk_class as RiskClass,
    write_scope: parseArr(r.write_scope_json),
    dependencies: parseArr(r.dependencies_json),
    token_estimate: r.token_estimate,
    provider: r.provider,
    runtime: r.runtime,
    is_north_star: r.is_north_star === 1,
    source_refs: parseArr(r.source_refs_json),
    approved_by: r.approved_by,
    approved_at: r.approved_at,
    last_dispatch_phid: r.last_dispatch_phid,
    retry_safe: r.retry_safe === 1,
    retry_safe_actor: r.retry_safe_actor ?? null,
    retry_safe_reason: r.retry_safe_reason ?? null,
    retry_safe_marked_at: r.retry_safe_marked_at ?? null,
    dispatch_retry_count: Number(r.dispatch_retry_count ?? 0),
    stale_duplicate_closeout_receipt: parseStaleDuplicateCloseoutReceipt(r.stale_duplicate_closeout_receipt_json),
    updated_by: r.updated_by,
    track_drift: r.track_drift === 1,
    flesh_status: (r.flesh_status as BacklogItem["flesh_status"]) ?? "unfleshed",
    flesh_source: r.flesh_source ?? null,
    flesh_confidence: r.flesh_confidence ?? null,
    flesh_error: r.flesh_error ?? null,
    flesh_attempts: r.flesh_attempts ?? 0,
    fleshed_at: r.fleshed_at ?? null,
    auto_ready_approved_at: r.auto_ready_approved_at ?? null,
    auto_ready_policy_version: r.auto_ready_policy_version ?? null,
    flesh_patch: parseFleshPatch(r.flesh_patch_json),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function parseFleshPatch(json: string | null): FleshPatch | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as FleshPatch) : null;
  } catch {
    return null;
  }
}

function parseStaleDuplicateCloseoutReceipt(json: string | null): StaleDuplicateCloseoutReceipt | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as StaleDuplicateCloseoutReceipt) : null;
  } catch {
    return null;
  }
}

export interface NewBacklogItem {
  team_id?: string;
  logical_key?: string | null;
  title: string;
  track?: string | null;
  to_agent?: string | null;
  dispatch_body?: string | null;
  priority?: number;
  value_score?: number | null;
  readiness_state?: ReadinessState;
  risk_class?: RiskClass;
  write_scope?: string[];
  dependencies?: string[];
  token_estimate?: number | null;
  provider?: string | null;
  runtime?: string | null;
  is_north_star?: boolean;
  source_refs?: string[];
  retry_safe?: boolean;
  /** Set when the item's track does not conform to the canonical-track-registry. */
  track_drift?: boolean;
}

export async function insertBacklogItem(adapter: DbAdapter, input: NewBacklogItem): Promise<BacklogItem> {
  const now = new Date().toISOString();
  const item_id = `coitem_${crypto.randomUUID()}`;
  await adapter.query(
    `INSERT INTO orchestration_backlog_item (
       item_id, team_id, logical_key, title, track, to_agent, dispatch_body, priority, value_score,
       readiness_state, risk_class, write_scope_json, dependencies_json, token_estimate,
       provider, runtime, is_north_star, source_refs_json, retry_safe, track_drift, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      item_id,
      input.team_id ?? "default",
      input.logical_key ?? null,
      input.title,
      input.track ?? null,
      input.to_agent ?? null,
      input.dispatch_body ?? null,
      input.priority ?? 5,
      input.value_score ?? null,
      input.readiness_state ?? "draft",
      input.risk_class ?? "routine",
      JSON.stringify(input.write_scope ?? []),
      JSON.stringify(input.dependencies ?? []),
      input.token_estimate ?? null,
      input.provider ?? null,
      input.runtime ?? null,
      input.is_north_star ? 1 : 0,
      JSON.stringify(input.source_refs ?? []),
      input.retry_safe ? 1 : 0,
      input.track_drift ? 1 : 0,
      now,
      now,
    ],
  );
  const got = await getBacklogItem(adapter, item_id);
  if (!got) throw new Error("insertBacklogItem: row not found after insert");
  return got;
}

export async function getBacklogItemByLogicalKey(
  adapter: DbAdapter,
  team_id: string,
  logical_key: string,
): Promise<BacklogItem | null> {
  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item
       WHERE team_id = $1 AND logical_key = $2
       ORDER BY
         CASE readiness_state
           WHEN 'in_flight' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'ready' THEN 2
           WHEN 'needs_chris_batch' THEN 3
           WHEN 'done' THEN 4
           WHEN 'needs_review' THEN 5
           WHEN 'draft' THEN 6
           ELSE 7
         END,
         updated_at DESC,
         created_at ASC
       LIMIT 1`,
    [team_id, logical_key],
  );
  return rows[0] ? rowToBacklogItem(rows[0]) : null;
}

export async function insertBacklogItemIfAbsentByLogicalKey(
  adapter: DbAdapter,
  input: NewBacklogItem,
): Promise<{ item: BacklogItem; inserted: boolean }> {
  const teamId = input.team_id ?? "default";
  const logicalKey = input.logical_key?.trim() || null;
  if (logicalKey) {
    const existing = await getBacklogItemByLogicalKey(adapter, teamId, logicalKey);
    if (existing) return { item: existing, inserted: false };
  }
  return { item: await insertBacklogItem(adapter, input), inserted: true };
}

/**
 * Defensive cross-check for callers that mint a FRESH logical_key per item
 * (e.g. maestra's refuel waves POSTing directly to /orchestration/backlog) —
 * the exact-logical_key dedup above can never catch this shape of duplicate,
 * since the new row's key never matches an existing row's key even when both
 * reference the SAME kapelle-feedback-register.md entry.
 *
 * Extracts register-native ID substrings (arf:, t-ckpt:, kfb:, or similar —
 * see register-id-extraction.ts) from the candidate's title/source_refs and
 * checks EVERY existing backlog row for the team — in ANY readiness_state,
 * including `done` — for the same substring in ITS title/source_refs.
 * Caller-agnostic: doesn't care whether the candidate came from a human,
 * another agent, or a future importer. Returns the first matching existing
 * row, or null when the candidate carries no register-native ID or no
 * existing row shares one.
 */
export async function findProbableDuplicateByRegisterId(
  adapter: DbAdapter,
  teamId: string,
  candidate: { title: string; source_refs?: string[] | null },
): Promise<BacklogItem | null> {
  const candidateIds = extractRegisterIds(
    `${candidate.title} ${(candidate.source_refs ?? []).join(" ")}`,
  );
  if (candidateIds.length === 0) return null;

  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item WHERE team_id = $1`,
    [teamId],
  );
  for (const row of rows) {
    const item = rowToBacklogItem(row);
    const existingIds = extractRegisterIds(`${item.title} ${item.source_refs.join(" ")}`);
    if (existingIds.some((id) => candidateIds.includes(id))) {
      return item;
    }
  }
  return null;
}

export async function getBacklogItem(adapter: DbAdapter, item_id: string): Promise<BacklogItem | null> {
  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item WHERE item_id = $1`,
    [item_id],
  );
  return rows[0] ? rowToBacklogItem(rows[0]) : null;
}

export async function listBacklogByState(
  adapter: DbAdapter,
  opts: { team_id?: string; state?: ReadinessState; limit?: number },
): Promise<BacklogItem[]> {
  const where: string[] = ["team_id = $1"];
  const params: unknown[] = [opts.team_id ?? "default"];
  if (opts.state) {
    where.push(`readiness_state = $${params.length + 1}`);
    params.push(opts.state);
  }
  params.push(opts.limit ?? 500);
  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item WHERE ${where.join(" AND ")}
     ORDER BY priority ASC, created_at ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToBacklogItem);
}

/**
 * Low-confidence fleshed rows that are parked in needs_review specifically for
 * confidence review. Explicitly approved rows are excluded because the
 * auto-promote policy treats approval as the confidence override.
 */
export async function listHeldConfidenceReviewItems(
  adapter: DbAdapter,
  opts: { team_id?: string; confidence_threshold: number; limit?: number },
): Promise<BacklogItem[]> {
  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item
       WHERE team_id = $1
         AND readiness_state = 'needs_review'
         AND flesh_confidence IS NOT NULL
         AND flesh_confidence < $2
         AND approved_by IS NULL
         AND approved_at IS NULL
         AND auto_ready_approved_at IS NULL
         AND COALESCE(flesh_status, 'unfleshed') <> 'approved_ready'
       ORDER BY flesh_confidence ASC, priority ASC, created_at ASC
       LIMIT $3`,
    [opts.team_id ?? "default", opts.confidence_threshold, opts.limit ?? 500],
  );
  return rows.map(rowToBacklogItem);
}

/** READY rows — the only items the tick may admit. */
export function listReadyItems(adapter: DbAdapter, team_id = "default"): Promise<BacklogItem[]> {
  return listBacklogByState(adapter, { team_id, state: "ready" });
}

/** All known item_ids for a team (dependency resolution during fleshing). */
export async function listAllItemIds(adapter: DbAdapter, team_id = "default"): Promise<Set<string>> {
  const { rows } = await adapter.query<{ item_id: string }>(
    `SELECT item_id FROM orchestration_backlog_item WHERE team_id = $1`,
    [team_id],
  );
  return new Set(rows.map((r) => r.item_id));
}

export async function listDoneItemIds(adapter: DbAdapter, team_id = "default"): Promise<Set<string>> {
  const { rows } = await adapter.query<{ item_id: string }>(
    `SELECT item_id FROM orchestration_backlog_item WHERE team_id = $1 AND readiness_state = 'done'`,
    [team_id],
  );
  return new Set(rows.map((r) => r.item_id));
}

/**
 * Dependency resolution index. Every item_id and non-empty logical_key maps to
 * whether that item is done; absence means the dependency reference is broken.
 */
export async function listDependencyResolution(adapter: DbAdapter, team_id = "default"): Promise<Map<string, boolean>> {
  const { rows } = await adapter.query<{ item_id: string; logical_key: string | null; readiness_state: string }>(
    `SELECT item_id, logical_key, readiness_state FROM orchestration_backlog_item WHERE team_id = $1`,
    [team_id],
  );
  const map = new Map<string, boolean>();
  for (const r of rows) {
    const done = r.readiness_state === "done";
    map.set(r.item_id, done);
    // If identifiers collide, the database row order decides the winner.
    if (r.logical_key) map.set(r.logical_key, done);
  }
  return map;
}

/**
 * The human/approval gate: promote a draft/needs_review item to READY. Refuses
 * to promote from any other state, and refuses items with no dispatch body/agent
 * (they would never be admissible).
 */
export async function promoteToReady(
  adapter: DbAdapter,
  item_id: string,
  approved_by: string,
  opts: { retry_safe?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; item?: BacklogItem }> {
  const item = await getBacklogItem(adapter, item_id);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.readiness_state !== "draft" && item.readiness_state !== "needs_review") {
    return { ok: false, reason: `cannot promote from ${item.readiness_state}` };
  }
  if (!item.to_agent || !item.dispatch_body) {
    return { ok: false, reason: "missing to_agent or dispatch_body" };
  }
  if (item.last_dispatch_phid && !opts.retry_safe && !item.retry_safe) {
    return { ok: false, reason: "previously dispatched row requires retry_safe=true to promote" };
  }
  if (item.logical_key) {
    const existing = await getBacklogItemByLogicalKey(adapter, item.team_id, item.logical_key);
    if (existing && existing.item_id !== item.item_id && blocksLogicalPromotion(existing.readiness_state)) {
      return { ok: false, reason: `logical work already ${existing.readiness_state}` };
    }
  }
  const now = new Date().toISOString();
  await adapter.query(
    `UPDATE orchestration_backlog_item
       SET readiness_state = 'ready',
           approved_by = $1,
           approved_at = $2,
           retry_safe = CASE WHEN $3 = 1 THEN 1 ELSE retry_safe END,
           updated_at = $4
     WHERE item_id = $5`,
    [approved_by, now, opts.retry_safe ? 1 : 0, now, item_id],
  );
  const updated = await getBacklogItem(adapter, item_id);
  return { ok: true, item: updated ?? undefined };
}

function blocksLogicalPromotion(state: ReadinessState): boolean {
  return [
    "ready",
    "queued",
    "in_flight",
    "blocked_dependency",
    "needs_chris_batch",
    "waiting_window",
    "done",
  ].includes(state);
}

/** Patch a subset of editable fields (used at the approval gate to attach the
 *  dispatch body/agent before promotion). Returns the updated item. */
export async function updateBacklogFields(
  adapter: DbAdapter,
  item_id: string,
  patch: Partial<
    Pick<
      NewBacklogItem,
      | "title"
      | "track"
      | "to_agent"
      | "dispatch_body"
      | "priority"
      | "value_score"
      | "risk_class"
      | "write_scope"
      | "dependencies"
      | "token_estimate"
      | "provider"
      | "runtime"
      | "is_north_star"
    >
  >,
  opts: { updated_by?: string | null } = {},
): Promise<BacklogItem | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${params.length + 1}`);
    params.push(val);
  };
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.track !== undefined) push("track", patch.track);
  if (patch.to_agent !== undefined) push("to_agent", patch.to_agent);
  if (patch.dispatch_body !== undefined) push("dispatch_body", patch.dispatch_body);
  if (patch.priority !== undefined) push("priority", patch.priority);
  if (patch.value_score !== undefined) push("value_score", patch.value_score);
  if (patch.risk_class !== undefined) push("risk_class", patch.risk_class);
  if (patch.write_scope !== undefined) push("write_scope_json", JSON.stringify(patch.write_scope));
  if (patch.dependencies !== undefined) push("dependencies_json", JSON.stringify(patch.dependencies));
  if (patch.token_estimate !== undefined) push("token_estimate", patch.token_estimate);
  if (patch.provider !== undefined) push("provider", patch.provider);
  if (patch.runtime !== undefined) push("runtime", patch.runtime);
  if (patch.is_north_star !== undefined) push("is_north_star", patch.is_north_star ? 1 : 0);
  if (sets.length === 0 && opts.updated_by === undefined) return getBacklogItem(adapter, item_id);
  if (opts.updated_by !== undefined) push("updated_by", opts.updated_by);
  push("updated_at", new Date().toISOString());
  params.push(item_id);
  await adapter.query(
    `UPDATE orchestration_backlog_item SET ${sets.join(", ")} WHERE item_id = $${params.length}`,
    params,
  );
  return getBacklogItem(adapter, item_id);
}

export async function setItemState(
  adapter: DbAdapter,
  item_id: string,
  state: ReadinessState,
  opts: { dispatch_phid?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `UPDATE orchestration_backlog_item
       SET readiness_state = $1, updated_at = $2,
           last_dispatch_phid = COALESCE($3, last_dispatch_phid)
     WHERE item_id = $4`,
    [state, now, opts.dispatch_phid ?? null, item_id],
  );
}

/**
 * Stage C late-binding: at FIRE time the daemon picks the pool builder and its
 * worktree, so persist the chosen `to_agent` + the worktree `write_scope` (a
 * distinct path per build) before the item flips to in_flight. The persisted
 * to_agent feeds the next tick's pool "building" set; the worktree write_scope
 * makes each in-flight build's lock distinct.
 */
/**
 * Persist a fire-time bind (to_agent + write_scope). `to_agent` is nullable so the
 * fire path can REVERT to an item's prior (possibly unbound) state when enqueue
 * fails after the bind — the RD-003 mode-(a) strand fix (never leave an item bound
 * to a worktree it never dispatched to).
 */
export async function bindItemForFire(
  adapter: DbAdapter,
  item_id: string,
  bind: { to_agent: string | null; write_scope: string[] },
): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `UPDATE orchestration_backlog_item
       SET to_agent = $1, write_scope_json = $2, updated_at = $3
     WHERE item_id = $4`,
    [bind.to_agent, JSON.stringify(bind.write_scope), now, item_id],
  );
}

/**
 * Resolve the raw dispatch status for each phid from the scheduler queue.
 * Keyed by `dispatch_phid` ALONE — NO team filter — because dispatch rows are
 * keyed by the team UUID while CO storage uses the team NAME ("default"); a
 * team-scoped read would never match (see factory.ts enqueue note). Phids are
 * globally unique, so a phid-only lookup is correct and trap-free. Missing phids
 * are simply absent from the returned map (the reaper treats absent as
 * unresolvable).
 */
export async function getDispatchStatusesByPhid(
  adapter: DbAdapter,
  phids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(phids.filter((p): p is string => !!p))];
  if (unique.length === 0) return out;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await adapter.query<{ dispatch_phid: string; status: string; recovery_status: string | null }>(
    `SELECT dispatch_phid, status, recovery_status
       FROM dispatch_scheduler_queue
      WHERE dispatch_phid IN (${placeholders})`,
    unique,
  );
  for (const r of rows) {
    out.set(r.dispatch_phid, r.recovery_status === "moot" ? "moot" : r.status);
  }
  return out;
}

export interface DispatchOutcome {
  dispatch_phid: string;
  status: string;
  recovery_status: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  recovery_attempts: number;
  promote: boolean;
  promotion_required_reason: string | null;
  promotion_result_json: string | null;
}

export type MarkDuplicateDispatchRetrySafeResult =
  | { ok: true; item: BacklogItem; retry_count: number }
  | { ok: false; status: number; error: string; reason: string; item?: BacklogItem; retry_count?: number; retry_cap?: number };

/**
 * Read dispatch details for backlog retry-readiness. Phid-only lookup mirrors
 * getDispatchStatusesByPhid because dispatch phids are globally unique while
 * orchestration team ids are display names.
 */
export async function getDispatchOutcomesByPhid(
  adapter: DbAdapter,
  phids: string[],
): Promise<Map<string, DispatchOutcome>> {
  const out = new Map<string, DispatchOutcome>();
  const unique = [...new Set(phids.filter((p): p is string => !!p))];
  if (unique.length === 0) return out;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await adapter.query<{
    dispatch_phid: string;
    status: string;
    recovery_status: string | null;
    failure_kind: string | null;
    failure_detail: string | null;
    recovery_attempts: number | null;
    promote: number | null;
    promotion_required_reason: string | null;
    promotion_result_json: string | null;
  }>(
    `SELECT dispatch_phid, status, recovery_status, failure_kind, failure_detail,
            recovery_attempts, promote, promotion_required_reason, promotion_result_json
       FROM dispatch_scheduler_queue
      WHERE dispatch_phid IN (${placeholders})`,
    unique,
  );
  for (const r of rows) {
    out.set(r.dispatch_phid, {
      dispatch_phid: r.dispatch_phid,
      status: r.recovery_status === "moot" ? "moot" : r.status,
      recovery_status: r.recovery_status,
      failure_kind: r.failure_kind,
      failure_detail: r.failure_detail,
      recovery_attempts: Number(r.recovery_attempts ?? 0),
      promote: r.promote == null ? true : Number(r.promote) === 1,
      promotion_required_reason: r.promotion_required_reason,
      promotion_result_json: r.promotion_result_json,
    });
  }
  return out;
}

export async function markFailedDuplicateDispatchRetrySafe(
  adapter: DbAdapter,
  item_id: string,
  opts: { actor: string; reason: string; team_id?: string },
): Promise<MarkDuplicateDispatchRetrySafeResult> {
  const actor = opts.actor.trim();
  const reason = opts.reason.trim();
  if (!actor) return { ok: false, status: 400, error: "actor_required", reason: "actor is required" };
  if (!reason) return { ok: false, status: 400, error: "reason_required", reason: "reason is required" };

  const item = await getBacklogItem(adapter, item_id);
  if (!item || (opts.team_id && item.team_id !== opts.team_id)) {
    return { ok: false, status: 404, error: "not_found", reason: "backlog item not found" };
  }
  if (item.readiness_state !== "ready") {
    return {
      ok: false,
      status: 409,
      error: "not_ready_duplicate_dispatch_row",
      reason: `cannot mark retry-safe from ${item.readiness_state}`,
      item,
    };
  }
  if (!item.last_dispatch_phid) {
    return {
      ok: false,
      status: 409,
      error: "missing_prior_dispatch",
      reason: "row has no prior dispatch phid",
      item,
    };
  }

  const outcome = (await getDispatchOutcomesByPhid(adapter, [item.last_dispatch_phid])).get(item.last_dispatch_phid);
  if (!outcome) {
    return {
      ok: false,
      status: 409,
      error: "prior_dispatch_unreadable",
      reason: "prior dispatch outcome is not readable",
      item,
    };
  }
  if (outcome.status !== "failed") {
    return {
      ok: false,
      status: 409,
      error: "prior_dispatch_not_failed",
      reason: `prior dispatch ${outcome.dispatch_phid} is ${outcome.status}; retry_safe is only allowed for failed retryable rows`,
      item,
    };
  }
  if (!dispatchFailureRetryable(outcome)) {
    return {
      ok: false,
      status: 409,
      error: "prior_dispatch_not_retryable",
      reason: `prior dispatch ${outcome.dispatch_phid} failed non-transiently (${outcome.failure_kind ?? "unknown"})`,
      item,
    };
  }

  const attempts = Math.max(item.dispatch_retry_count, outcome.recovery_attempts);
  const retryCap = DEFAULT_RECOVERY_CONFIG.max_attempts;
  if (attempts >= retryCap) {
    return {
      ok: false,
      status: 409,
      error: "retry_cap_reached",
      reason: `retry cap reached (${attempts}/${retryCap})`,
      item,
      retry_count: attempts,
      retry_cap: retryCap,
    };
  }

  const now = new Date().toISOString();
  const nextRetryCount = attempts + 1;
  await adapter.query(
    `UPDATE orchestration_backlog_item
        SET retry_safe = 1,
            retry_safe_actor = $1,
            retry_safe_reason = $2,
            retry_safe_marked_at = $3,
            dispatch_retry_count = $4,
            updated_by = $5,
            updated_at = $6
      WHERE item_id = $7
        AND team_id = $8
        AND readiness_state = 'ready'
        AND last_dispatch_phid = $9
        AND COALESCE(retry_safe, 0) = 0`,
    [actor, reason, now, nextRetryCount, actor, now, item.item_id, item.team_id, item.last_dispatch_phid],
  );
  const updated = await getBacklogItem(adapter, item.item_id);
  if (!updated?.retry_safe) {
    return {
      ok: false,
      status: 409,
      error: "retry_safe_not_updated",
      reason: "row changed before retry-safe marker was applied",
      item: updated ?? item,
    };
  }
  return { ok: true, item: updated, retry_count: nextRetryCount };
}

/**
 * RD-014: which of `names` are currently a healthy/running agent. No team
 * filter, by name only — mirrors getDispatchStatusesByPhid's "phid-only, no
 * team filter" trap avoidance, since continuous-orchestration's team_id
 * ("default", a name) does not match the `agents` table's team_id (a UUID).
 * An agent name can have more than one row (e.g. a stale port from a prior
 * process alongside the live one) — healthy if ANY non-deleted row for that
 * name is `running`. Names absent from the returned set are either unknown
 * or not running; both are treated as "not healthy" by the admission gate.
 */
export async function getHealthyAgentNames(
  adapter: DbAdapter,
  names: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(names.filter((n): n is string => !!n))];
  if (unique.length === 0) return out;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await adapter.query<{ name: string }>(
    `SELECT DISTINCT name FROM agents
      WHERE name IN (${placeholders}) AND status = 'running' AND deleted_at IS NULL`,
    unique,
  );
  for (const r of rows) out.add(r.name);
  return out;
}

/**
 * Registered runtime per agent name. No team filter for the same reason as
 * getHealthyAgentNames: orchestration storage uses team names while agents rows
 * are UUID-scoped. Prefer a currently-running non-deleted row when duplicates
 * exist, but return any known runtime so status can diagnose a lane mismatch.
 */
export async function getAgentRuntimeMap(
  adapter: DbAdapter,
  names: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(names.filter((n): n is string => !!n))];
  if (unique.length === 0) return out;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await adapter.query<{ name: string; runtime: string | null; running_rank: number }>(
    `SELECT name, runtime, CASE WHEN status = 'running' AND deleted_at IS NULL THEN 0 ELSE 1 END AS running_rank
       FROM agents
      WHERE name IN (${placeholders}) AND deleted_at IS NULL
      ORDER BY running_rank ASC, name ASC`,
    unique,
  );
  for (const r of rows) {
    if (r.runtime && !out.has(r.name)) out.set(r.name, r.runtime);
  }
  return out;
}

/**
 * Live runtime telemetry for all known logical agent names. Prefer a running
 * non-deleted row when duplicate process rows exist for the same name.
 */
export async function getAllAgentRuntimeMap(adapter: DbAdapter): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { rows } = await adapter.query<{ name: string; runtime: string | null; running_rank: number }>(
    `SELECT name, runtime, CASE WHEN status = 'running' AND deleted_at IS NULL THEN 0 ELSE 1 END AS running_rank
       FROM agents
      WHERE deleted_at IS NULL
      ORDER BY running_rank ASC, name ASC`,
  );
  for (const r of rows) {
    if (r.runtime && !out.has(r.name)) out.set(r.name, r.runtime);
  }
  return out;
}

export interface ReadyRuntimeRepair {
  item_id: string;
  to_agent: string;
  from_provider: string | null;
  from_runtime: string | null;
  to_provider: string;
  to_runtime: string;
  reason?: string;
  applied?: boolean;
}

export interface StaleReadyReconcileResult {
  scanned: number;
  closed: number;
  superseded: number;
  preserved_retry_safe: number;
  dry_run: boolean;
  items: Array<{
    item_id: string;
    dispatch_phid: string;
    from_state: "ready";
    to_state: "done" | "superseded";
    dispatch_status: string;
    artifact_path: string | null;
    reason: string;
    receipt: StaleDuplicateCloseoutReceipt;
  }>;
}

export type CloseStaleDuplicateBacklogRowResult =
  | {
      ok: true;
      item: BacklogItem;
      receipt: StaleDuplicateCloseoutReceipt;
    }
  | {
      ok: false;
      status: number;
      error: string;
      reason: string;
      item?: BacklogItem;
    };

const READY_RECONCILE_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "moot", "superseded"]);
const OFFLINE_AGENT_STATUSES = new Set(["stopped", "offline", "deleted", "unhealthy", "error"]);

function buildStaleDuplicateCloseoutReceipt(
  row: BacklogRow & {
    dispatch_status: string | null;
    dispatch_recovery_status: string | null;
    promotion_result_json: string | null;
  },
  actor: string,
): { toState: "done" | "superseded"; reason: string; receipt: StaleDuplicateCloseoutReceipt } | null {
  const status = row.dispatch_recovery_status === "moot" ? "moot" : row.dispatch_status;
  if (!status || !READY_RECONCILE_TERMINAL_STATUSES.has(status)) return null;
  if (status === "failed" && !promotionCompletedAndVerified(row.promotion_result_json) && dispatchFailureRetryable(row)) {
    return null;
  }

  const toState: "done" | "superseded" =
    status === "done" || promotionCompletedAndVerified(row.promotion_result_json) ? "done" : "superseded";
  const reason =
    toState === "done"
      ? `already-dispatched ready row closed after terminal dispatch ${status}`
      : `already-dispatched ready row superseded after terminal dispatch ${status}`;
  return {
    toState,
    reason,
    receipt: {
      schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
      closed_by: actor,
      closed_at: new Date().toISOString(),
      from_state: "ready",
      to_state: toState,
      reason: "close_or_ignore",
      track: row.track ?? null,
      next_action: toState === "done" ? "close_duplicate_row" : "supersede_duplicate_row",
      prior_dispatch_phid: row.last_dispatch_phid ?? "",
      prior_dispatch_status: status,
      successor_dispatch_phid: null,
      redispatch_safety: {
        safe_to_not_redispatch: true,
        reason:
          toState === "done"
            ? "prior dispatch already reached terminal done state; reopening would duplicate completed work"
            : `prior dispatch is terminal ${status}; this row is stale duplicate backlog state and not retry fuel`,
      },
    },
  };
}

function appendSourceRefs(sourceRefsJson: string, refsToAppend: Array<string | null>): string {
  const refs = parseArr(sourceRefsJson);
  for (const ref of refsToAppend) {
    if (!ref) continue;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return JSON.stringify(refs);
}

function appendSourceRef(sourceRefsJson: string, artifactPath: string | null): string {
  return appendSourceRefValue(sourceRefsJson, artifactPath ? `dispatch_artifact:${artifactPath}` : null);
}

function appendSourceRefValue(sourceRefsJson: string, ref: string | null): string {
  return appendSourceRefs(sourceRefsJson, [ref]);
}

function itemContainsWave66(row: BacklogRow): boolean {
  const haystack = [
    row.title,
    row.dispatch_body,
    row.logical_key,
    row.track,
    ...parseArr(row.source_refs_json),
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return /\bwave\s*66\b/i.test(haystack);
}

async function isOfflineTargetAgent(adapter: DbAdapter, target: string | null): Promise<boolean> {
  const name = target?.trim();
  if (!name) return true;
  if (name.startsWith("pool:")) return false;
  const { rows } = await adapter.query<{ status: string | null }>(
    `SELECT status
       FROM agents
      WHERE name = $1 AND deleted_at IS NULL
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`,
    [name],
  );
  const status = rows[0]?.status?.trim().toLowerCase() ?? null;
  return !status || OFFLINE_AGENT_STATUSES.has(status);
}

export interface OfflineSupersededReadyReconcileResult {
  ok: boolean;
  dry_run: boolean;
  item_id: string;
  superseding_coitem_id: string;
  from_state: "ready";
  to_state: "superseded";
  old_target_agent: string | null;
  reason: string;
  receipt: StaleDuplicateCloseoutReceipt;
}

export async function reconcileOfflineSupersededReadyRow(
  adapter: DbAdapter,
  opts: {
    team_id?: string;
    item_id: string;
    superseding_coitem_id: string;
    reason: string;
    actor?: string;
    dry_run?: boolean;
  },
): Promise<OfflineSupersededReadyReconcileResult> {
  const teamId = opts.team_id ?? "default";
  const itemId = opts.item_id.trim();
  const supersedingCoitemId = opts.superseding_coitem_id.trim();
  const actor = opts.actor?.trim() || "operator";
  const reason = opts.reason.trim();
  const dryRun = opts.dry_run === true;

  if (!itemId) throw new Error("item_id is required");
  if (!supersedingCoitemId) throw new Error("superseding_coitem_id is required");
  if (!reason) throw new Error("reason is required");
  if (itemId === supersedingCoitemId) throw new Error("superseding_coitem_id must differ from item_id");

  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item
      WHERE team_id = $1 AND item_id IN ($2, $3)`,
    [teamId, itemId, supersedingCoitemId],
  );
  const stale = rows.find((row) => row.item_id === itemId);
  const superseding = rows.find((row) => row.item_id === supersedingCoitemId);
  if (!stale) throw new Error(`ready row not found: ${itemId}`);
  if (!superseding) throw new Error(`superseding coitem not found: ${supersedingCoitemId}`);
  if (stale.readiness_state !== "ready") throw new Error(`cannot supersede ${itemId} from ${stale.readiness_state}`);
  if (!(await isOfflineTargetAgent(adapter, stale.to_agent))) {
    throw new Error(`target agent is not offline: ${stale.to_agent ?? "(none)"}`);
  }
  if (!itemContainsWave66(superseding)) {
    throw new Error(`superseding coitem is not marked as Wave66 work: ${supersedingCoitemId}`);
  }
  if (Date.parse(superseding.created_at) < Date.parse(stale.created_at)) {
    throw new Error(`superseding coitem is not fresher than ${itemId}`);
  }

  const closedAt = new Date().toISOString();
  const receipt: StaleDuplicateCloseoutReceipt = {
    schema_version: "orchestration.stale_duplicate_closeout_receipt.v1",
    closed_by: actor,
    closed_at: closedAt,
    actor,
    timestamp: closedAt,
    from_state: "ready",
    to_state: "superseded",
    reason: "offline_target_superseded_by_fresher_wave66",
    track: stale.track ?? null,
    next_action: "supersede_offline_ready_row",
    prior_dispatch_phid: stale.last_dispatch_phid ?? "",
    prior_dispatch_status: "target_offline",
    successor_dispatch_phid: superseding.last_dispatch_phid ?? null,
    old_target_agent: stale.to_agent ?? null,
    superseding_coitem_id: supersedingCoitemId,
    supersession_reason: reason,
    redispatch_safety: {
      safe_to_not_redispatch: true,
      reason,
    },
  };

  if (!dryRun) {
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET readiness_state = 'superseded',
              source_refs_json = $1,
              retry_safe = 0,
              stale_duplicate_closeout_receipt_json = $2,
              updated_by = $3,
              updated_at = $4
        WHERE team_id = $5
          AND item_id = $6
          AND readiness_state = 'ready'`,
      [
        appendSourceRefValue(stale.source_refs_json, `superseded_by:${supersedingCoitemId}`),
        JSON.stringify(receipt),
        actor,
        closedAt,
        teamId,
        itemId,
      ],
    );
  }

  return {
    ok: true,
    dry_run: dryRun,
    item_id: itemId,
    superseding_coitem_id: supersedingCoitemId,
    from_state: "ready",
    to_state: "superseded",
    old_target_agent: stale.to_agent ?? null,
    reason,
    receipt,
  };
}

/**
 * Close stale READY rows that were already dispatched and now have terminal
 * scheduler evidence. This is deliberately operator-triggered and conservative:
 * retry_safe rows are preserved because a human explicitly approved a refire.
 */
export async function reconcileStaleAlreadyDispatchedReadyRows(
  adapter: DbAdapter,
  opts: { team_id?: string; dry_run?: boolean; actor?: string } = {},
): Promise<StaleReadyReconcileResult> {
  const teamId = opts.team_id ?? "default";
  const dryRun = opts.dry_run === true;
  const actor = opts.actor?.trim() || "operator";
  const { rows } = await adapter.query<
    BacklogRow & {
      dispatch_status: string | null;
      dispatch_recovery_status: string | null;
      artifact_path: string | null;
      failure_kind: string | null;
      failure_detail: string | null;
      promotion_result_json: string | null;
    }
  >(
    `SELECT i.*,
            q.status AS dispatch_status,
            q.recovery_status AS dispatch_recovery_status,
            q.artifact_path AS artifact_path,
            q.failure_kind AS failure_kind,
            q.failure_detail AS failure_detail,
            q.promotion_result_json AS promotion_result_json
       FROM orchestration_backlog_item i
       LEFT JOIN dispatch_scheduler_queue q
         ON q.dispatch_phid = i.last_dispatch_phid
      WHERE i.team_id = $1
        AND i.readiness_state = 'ready'
        AND i.last_dispatch_phid IS NOT NULL
      ORDER BY i.updated_at ASC, i.created_at ASC`,
    [teamId],
  );

  const result: StaleReadyReconcileResult = {
    scanned: rows.length,
    closed: 0,
    superseded: 0,
    preserved_retry_safe: 0,
    dry_run: dryRun,
    items: [],
  };

  for (const row of rows) {
    if (row.retry_safe === 1) {
      result.preserved_retry_safe += 1;
      continue;
    }

    const built = buildStaleDuplicateCloseoutReceipt(row, actor);
    if (!built) continue;
    const { toState, reason, receipt } = built;

    if (!dryRun) {
      await adapter.query(
        `UPDATE orchestration_backlog_item
            SET readiness_state = $1,
                source_refs_json = $2,
                retry_safe = 0,
                stale_duplicate_closeout_receipt_json = $3,
                updated_by = $4,
                updated_at = $5
          WHERE item_id = $6
            AND readiness_state = 'ready'
            AND COALESCE(retry_safe, 0) = 0`,
        [
          toState,
          appendSourceRefs(row.source_refs_json, [
            row.artifact_path ? `dispatch_artifact:${row.artifact_path}` : null,
            `manager:/orchestration/backlog/${row.item_id}#stale-duplicate-closeout-receipt`,
          ]),
          JSON.stringify(receipt),
          actor,
          receipt.closed_at,
          row.item_id,
        ],
      );
    }

    if (toState === "done") result.closed += 1;
    else result.superseded += 1;
    result.items.push({
      item_id: row.item_id,
      dispatch_phid: row.last_dispatch_phid ?? "",
      from_state: "ready",
      to_state: toState,
      dispatch_status: receipt.prior_dispatch_status,
      artifact_path: row.artifact_path ?? null,
      reason,
      receipt,
    });
  }

  return result;
}

export async function closeStaleDuplicateBacklogRow(
  adapter: DbAdapter,
  itemId: string,
  opts: {
    actor: string;
    expected_last_dispatch_phid?: string;
    team_id?: string;
  },
): Promise<CloseStaleDuplicateBacklogRowResult> {
  const actor = opts.actor.trim();
  if (!actor) return { ok: false, status: 400, error: "actor_required", reason: "actor is required" };

  const item = await getBacklogItem(adapter, itemId);
  if (!item || (opts.team_id && item.team_id !== opts.team_id)) {
    return { ok: false, status: 404, error: "not_found", reason: "backlog item not found" };
  }
  if (item.readiness_state !== "ready") {
    return {
      ok: false,
      status: 409,
      error: "not_ready_duplicate_dispatch_row",
      reason: `cannot close stale duplicate from ${item.readiness_state}`,
      item,
    };
  }
  if (item.retry_safe) {
    return {
      ok: false,
      status: 409,
      error: "retry_safe_duplicate_dispatch_row",
      reason: "retry_safe rows require explicit retry handling, not stale duplicate closeout",
      item,
    };
  }
  if (!item.last_dispatch_phid) {
    return {
      ok: false,
      status: 409,
      error: "missing_prior_dispatch",
      reason: "row has no prior dispatch phid",
      item,
    };
  }
  if (opts.expected_last_dispatch_phid && item.last_dispatch_phid !== opts.expected_last_dispatch_phid) {
    return {
      ok: false,
      status: 409,
      error: "last_dispatch_mismatch",
      reason: `row now points at ${item.last_dispatch_phid}, expected ${opts.expected_last_dispatch_phid}`,
      item,
    };
  }

  const { rows } = await adapter.query<
    BacklogRow & {
      dispatch_status: string | null;
      dispatch_recovery_status: string | null;
      artifact_path: string | null;
      failure_kind: string | null;
      failure_detail: string | null;
      promotion_result_json: string | null;
    }
  >(
    `SELECT i.*,
            q.status AS dispatch_status,
            q.recovery_status AS dispatch_recovery_status,
            q.artifact_path AS artifact_path,
            q.failure_kind AS failure_kind,
            q.failure_detail AS failure_detail,
            q.promotion_result_json AS promotion_result_json
       FROM orchestration_backlog_item i
       LEFT JOIN dispatch_scheduler_queue q
         ON q.dispatch_phid = i.last_dispatch_phid
      WHERE i.item_id = $1
        AND i.team_id = $2
      LIMIT 1`,
    [itemId, opts.team_id ?? item.team_id],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "not_found", reason: "backlog item not found" };

  const built = buildStaleDuplicateCloseoutReceipt(row, actor);
  if (!built) {
    return {
      ok: false,
      status: 409,
      error: "prior_dispatch_not_terminal_or_safe",
      reason: "prior dispatch does not have terminal evidence safe for stale duplicate closeout",
      item,
    };
  }
  const { toState, receipt } = built;

  await adapter.query(
    `UPDATE orchestration_backlog_item
        SET readiness_state = $1,
            source_refs_json = $2,
            retry_safe = 0,
            stale_duplicate_closeout_receipt_json = $3,
            updated_by = $4,
            updated_at = $5
      WHERE item_id = $6
        AND team_id = $7
        AND readiness_state = 'ready'
        AND COALESCE(retry_safe, 0) = 0
        AND last_dispatch_phid = $8`,
    [
      toState,
      appendSourceRefs(row.source_refs_json, [
        row.artifact_path ? `dispatch_artifact:${row.artifact_path}` : null,
        `manager:/orchestration/backlog/${row.item_id}#stale-duplicate-closeout-receipt`,
      ]),
      JSON.stringify(receipt),
      actor,
      receipt.closed_at,
      row.item_id,
      row.team_id,
      row.last_dispatch_phid ?? "",
    ],
  );

  const updated = await getBacklogItem(adapter, itemId);
  if (!updated || updated.readiness_state === "ready" || !updated.stale_duplicate_closeout_receipt) {
    return {
      ok: false,
      status: 409,
      error: "stale_duplicate_not_updated",
      reason: "row changed before stale duplicate closeout was applied",
      item: updated ?? item,
    };
  }

  return { ok: true, item: updated, receipt };
}

function dispatchFailureRetryable(outcome: { failure_kind: string | null; failure_detail: string | null }): boolean {
  if (outcome.failure_kind === "scheduler_wedged") return true;
  const detail = (outcome.failure_detail ?? "").toLowerCase();
  return DEFAULT_RECOVERY_CONFIG.retryable_detail_markers.some((marker) => detail.includes(marker.toLowerCase()));
}

/**
 * Repair stale ready-fuel metadata after an agent lane changes runtime.
 *
 * The flesher stamps provider/runtime before the final lane may be known. A
 * ready, approved row targeting a Codex agent must not stay pinned to the old
 * Anthropic/Claude lane, because admission will correctly hold it forever as a
 * provider/runtime mismatch. Build-pool rows can also keep the logical owner
 * lane (`roger`, `regina`, or `pool:*`) while the actual admission target
 * late-binds to a maintained Codex builder, so stale Claude metadata must be
 * normalized before the admission planner sees it.
 *
 * The mirror case is artifact-only CTO/Claude-lane rows: they do not write repo
 * code and must stay on Anthropic/Claude metadata when a previous repair or
 * manual edit stamped them as Codex. This pass is deliberately narrow and
 * idempotent, and already-correct rows are ignored. It never changes `to_agent`.
 */
const LEGACY_CODEX_OWNER_LANES = new Set(["roger", "regina"]);
const LEGACY_CLAUDE_OWNER_LANES = new Set(["cto", "maestra", "claude"]);
const CLAUDE_RUNTIMES = new Set(["claude-code-cli", "claude-agent-sdk", "claude-code-local"]);

function isClaudeRuntime(runtime: string | null): boolean {
  return runtime ? CLAUDE_RUNTIMES.has(normalizeRuntime(runtime)) : false;
}

function isArtifactOnlyReadyRow(row: BacklogRow): boolean {
  const writeScopes = parseArr(row.write_scope_json).map((scope) => scope.trim().toLowerCase()).filter(Boolean);
  const sourceRefs = parseArr(row.source_refs_json).map((ref) => ref.trim().toLowerCase()).filter(Boolean);
  const artifactLike = (value: string) =>
    value === "output" ||
    value === "output/" ||
    value.includes("/output/") ||
    value.endsWith("/output") ||
    value.startsWith("output/") ||
    value.startsWith("artifact:") ||
    value.startsWith("artifacts/");

  if (writeScopes.length > 0) return writeScopes.every(artifactLike);
  return sourceRefs.length > 0 && sourceRefs.every(artifactLike);
}

function shouldRepairReadyRowToCodex(row: BacklogRow & { agent_runtime: string | null; agent_status: string | null }): {
  repair: boolean;
  reason: string;
} {
  const targetRuntime = row.agent_runtime ? normalizeRuntime(row.agent_runtime) : null;
  if (targetRuntime === "codex") return { repair: true, reason: "target_agent_runtime_codex" };

  const target = row.to_agent?.trim().toLowerCase() ?? "";
  if (target.startsWith("pool:")) return { repair: true, reason: "explicit_pool_owner_lane" };

  const currentRuntime = row.runtime ? normalizeRuntime(row.runtime) : null;
  const currentProvider = row.provider ?? (currentRuntime ? resolveProviderFromRuntime(currentRuntime) : null);
  const carriesClaudeMetadata =
    currentProvider === "anthropic" ||
    currentRuntime === "claude-code-cli" ||
    currentRuntime === "claude-agent-sdk" ||
    currentRuntime === "claude-code-local";
  if (!carriesClaudeMetadata) return { repair: false, reason: "not_claude_metadata" };

  if (LEGACY_CODEX_OWNER_LANES.has(target) && row.agent_status !== "running") {
    return { repair: true, reason: "legacy_owner_lane_unavailable" };
  }
  return { repair: false, reason: "not_codex_repair_candidate" };
}

function shouldRepairReadyRowToClaude(row: BacklogRow & { agent_runtime: string | null; agent_status: string | null }): {
  repair: boolean;
  reason: string;
} {
  if (!isArtifactOnlyReadyRow(row)) return { repair: false, reason: "not_artifact_only" };

  const targetRuntime = row.agent_runtime ? normalizeRuntime(row.agent_runtime) : null;
  const target = row.to_agent?.trim().toLowerCase() ?? "";
  const targetsClaudeLane = isClaudeRuntime(targetRuntime) || LEGACY_CLAUDE_OWNER_LANES.has(target);
  if (!targetsClaudeLane) return { repair: false, reason: "not_claude_lane" };

  const currentRuntime = row.runtime ? normalizeRuntime(row.runtime) : null;
  const currentProvider = row.provider ?? (currentRuntime ? resolveProviderFromRuntime(currentRuntime) : null);
  if (currentRuntime === "claude-code-cli" && currentProvider === "anthropic") {
    return { repair: false, reason: "already_claude_metadata" };
  }

  return {
    repair: true,
    reason: targetRuntime && isClaudeRuntime(targetRuntime) ? "artifact_only_target_agent_runtime_claude" : "artifact_only_legacy_claude_lane",
  };
}

export async function repairReadyCodexRuntimeMetadata(
  adapter: DbAdapter,
  team_id = "default",
  opts: { apply?: boolean } = {},
): Promise<ReadyRuntimeRepair[]> {
  const apply = opts.apply ?? true;
  const { rows } = await adapter.query<BacklogRow & { agent_runtime: string | null; agent_status: string | null }>(
    `SELECT i.*, a.runtime AS agent_runtime, a.status AS agent_status
       FROM orchestration_backlog_item i
       LEFT JOIN (
         SELECT name, runtime, status
           FROM (
             SELECT name, runtime, status,
                    ROW_NUMBER() OVER (
                      PARTITION BY name
                      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, name ASC
                    ) AS rn
               FROM agents
              WHERE deleted_at IS NULL
           ) ranked_agents
          WHERE rn = 1
       ) a ON a.name = i.to_agent
      WHERE i.team_id = $1
        AND i.readiness_state = 'ready'
        AND i.approved_by IS NOT NULL
        AND i.approved_at IS NOT NULL
        AND i.to_agent IS NOT NULL`,
    [team_id],
  );

  const repairs: ReadyRuntimeRepair[] = [];
  for (const row of rows) {
    const claudeDecision = shouldRepairReadyRowToClaude(row);
    const decision = claudeDecision.repair ? claudeDecision : shouldRepairReadyRowToCodex(row);
    if (!decision.repair) continue;
    const targetRuntime = claudeDecision.repair ? "claude-code-cli" : "codex";
    const targetProvider = resolveProviderFromRuntime(targetRuntime);
    const currentRuntime = row.runtime ? normalizeRuntime(row.runtime) : null;
    const currentProvider = row.provider ?? (currentRuntime ? resolveProviderFromRuntime(currentRuntime) : null);
    const rawRuntime = row.runtime?.trim() || null;
    if (currentRuntime === targetRuntime && currentProvider === targetProvider && rawRuntime === targetRuntime) continue;

    if (apply) {
      const now = new Date().toISOString();
      await adapter.query(
        `UPDATE orchestration_backlog_item
            SET provider = $1, runtime = $2, updated_at = $3
          WHERE item_id = $4
            AND readiness_state = 'ready'
            AND approved_by IS NOT NULL
            AND approved_at IS NOT NULL`,
        [targetProvider, targetRuntime, now, row.item_id],
      );
    }
    repairs.push({
      item_id: row.item_id,
      to_agent: row.to_agent ?? "",
      from_provider: row.provider,
      from_runtime: row.runtime,
      to_provider: targetProvider,
      to_runtime: targetRuntime,
      reason: decision.reason,
      applied: apply,
    });
  }
  return repairs;
}

// ── Auto-flesh (daemon SELF-REFUEL) ──────────────────────────────────

/**
 * The flesh candidate queue: skeletons the flesher may work. `unfleshed` and
 * `failed` (retryable) rows in `needs_review`, ordered by priority. `failed`
 * rows past the attempt cap are excluded.
 */
export async function listFleshCandidates(
  adapter: DbAdapter,
  opts: { team_id?: string; limit?: number; max_attempts?: number; item_ids?: string[] },
): Promise<BacklogItem[]> {
  const team_id = opts.team_id ?? "default";
  const maxAttempts = opts.max_attempts ?? 3;
  const logicalWorkNotBlockedByPeer = `
    NOT EXISTS (
      SELECT 1 FROM orchestration_backlog_item peer
       WHERE peer.team_id = orchestration_backlog_item.team_id
         AND peer.logical_key = orchestration_backlog_item.logical_key
         AND peer.item_id <> orchestration_backlog_item.item_id
         AND orchestration_backlog_item.logical_key IS NOT NULL
         AND peer.readiness_state IN (
           'ready','queued','in_flight','blocked_dependency',
           'needs_chris_batch','waiting_window','done'
         )
    )`;
  if (opts.item_ids && opts.item_ids.length > 0) {
    const placeholders = opts.item_ids.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await adapter.query<BacklogRow>(
      `SELECT * FROM orchestration_backlog_item
         WHERE team_id = $1 AND item_id IN (${placeholders})
           AND readiness_state IN ('needs_review', 'draft')
           AND ${logicalWorkNotBlockedByPeer}
         ORDER BY priority ASC, created_at ASC`,
      [team_id, ...opts.item_ids],
    );
    return rows.map(rowToBacklogItem);
  }
  const { rows } = await adapter.query<BacklogRow>(
    `SELECT * FROM orchestration_backlog_item
       WHERE team_id = $1
         AND readiness_state IN ('needs_review', 'draft')
         AND (flesh_status = 'unfleshed' OR (flesh_status = 'failed' AND flesh_attempts < $2))
         AND ${logicalWorkNotBlockedByPeer}
       ORDER BY is_north_star DESC, priority ASC, created_at ASC
       LIMIT $3`,
    [team_id, maxAttempts, opts.limit ?? 50],
  );
  return rows.map(rowToBacklogItem);
}

export interface FleshOutcome {
  item_id: string;
  flesh_status: FleshStatus;
  flesh_source: string;
  flesh_confidence: number;
  flesh_error?: string | null;
  policy_version?: string | null;
  patch?: FleshPatch | null;
  /** When true (approved_ready), apply the patch's dispatch fields + promote. */
  promote?: boolean;
  approved_by?: string;
}

/**
 * Record a flesh result. Always stamps flesh_* bookkeeping and bumps the
 * attempt counter. When `promote` is set, applies the patch's dispatch fields
 * and flips readiness_state to `ready` (the auto-ready path — no human gate,
 * gated by the policy upstream). Otherwise the row stays `needs_review` (held
 * for Chris's batch) or `draft`. Returns the updated item.
 */
export async function recordFleshOutcome(
  adapter: DbAdapter,
  outcome: FleshOutcome,
): Promise<BacklogItem | null> {
  const item = await getBacklogItem(adapter, outcome.item_id);
  if (!item) return null;

  // Idempotency guard (operator dispatch f4ce4782): a flesh / re-ingest pass must
  // never demote or re-route work that has moved past the review gate. Only
  // draft / needs_review items are flesh-eligible; anything at `ready` or beyond
  // is left untouched (no write), so a re-flesh can't undo a promotion or the
  // ready-fuel floor.
  if (item.readiness_state !== "draft" && item.readiness_state !== "needs_review") {
    return item;
  }
  // Sticky routing guard: never overwrite a to_agent / priority an operator or
  // human explicitly set. Actor-attributed PATCHes set `updated_by`, while
  // authored backlog rows can arrive with a target already on the row before a
  // flesh tick fills the rest of the dispatch fields.
  const operatorRouted = item.updated_by != null;
  const hasAuthoredTargetAgent = typeof item.to_agent === "string" && item.to_agent.trim().length > 0;

  const now = new Date().toISOString();
  const patch = outcome.patch ?? null;
  const promote = !!outcome.promote && !!patch;

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${params.length + 1}`);
    params.push(val);
  };

  push("flesh_status", outcome.flesh_status);
  push("flesh_source", outcome.flesh_source);
  push("flesh_confidence", outcome.flesh_confidence);
  push("flesh_error", outcome.flesh_error ?? null);
  push("flesh_attempts", (item.flesh_attempts ?? 0) + 1);
  push("fleshed_at", now);
  push("auto_ready_policy_version", outcome.policy_version ?? null);
  push("flesh_patch_json", patch ? JSON.stringify(patch) : null);

  // Sticky dispatch_body guard: a `needs_review`/`draft` item can already carry
  // a real, human/maestra-authored dispatch_body — POST /orchestration/backlog
  // forces every new item into draft/needs_review regardless of the requested
  // state (only the promote endpoint may set `ready`), so there is a window
  // between "item created with a full dispatch_body" and "item promoted" where
  // it is genuinely flesh-eligible per the idempotency guard above. If the
  // daemon's periodic flesh tick fires in that window, it would otherwise
  // overwrite the authored body with a generic template before promotion
  // completes (confirmed reproducing live 2026-07-04: created+approved at
  // 16:20:29, dispatch_body clobbered at 16:21:56). Mirrors the sticky-routing
  // guard above, applied to dispatch_body specifically: only a true empty
  // skeleton (no existing dispatch_body) may have it set by a flesh pass.
  const hasAuthoredDispatchBody = typeof item.dispatch_body === "string" && item.dispatch_body.trim().length > 0;

  if (patch) {
    // Persist the generated dispatch payload so the row is dispatchable (or
    // one-click approvable) regardless of the auto-ready decision.
    if (!hasAuthoredDispatchBody) push("dispatch_body", patch.dispatch_body);
    push("risk_class", patch.risk_class);
    push("write_scope_json", JSON.stringify(patch.write_scope));
    push("dependencies_json", JSON.stringify(patch.dependencies));
    push("token_estimate", patch.token_estimate);
    push("provider", patch.provider);
    push("runtime", patch.runtime);
    if (patch.value_score !== null && patch.value_score !== undefined) push("value_score", patch.value_score);
    // Routing fields are sticky: keep an operator/human-authored to_agent +
    // priority instead of resetting it to the flesher's default lane pick.
    if (!operatorRouted && !hasAuthoredTargetAgent) {
      push("to_agent", patch.to_agent);
      push("priority", patch.priority);
    }
  }

  if (promote) {
    push("readiness_state", "ready");
    push("approved_by", outcome.approved_by ?? "continuous-orchestration");
    push("approved_at", now);
    push("auto_ready_approved_at", now);
  }

  push("updated_at", now);
  params.push(outcome.item_id);
  await adapter.query(
    `UPDATE orchestration_backlog_item SET ${sets.join(", ")} WHERE item_id = $${params.length}`,
    params,
  );
  return getBacklogItem(adapter, outcome.item_id);
}

/** Counts by flesh_status + readiness, for /orchestration/status + the queue. */
export async function getFleshCounts(
  adapter: DbAdapter,
  team_id = "default",
): Promise<Record<string, number>> {
  const { rows } = await adapter.query<{ flesh_status: string | null; n: number }>(
    `SELECT flesh_status, COUNT(*) AS n FROM orchestration_backlog_item
       WHERE team_id = $1 GROUP BY flesh_status`,
    [team_id],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.flesh_status ?? "unfleshed"] = Number(r.n);
  return out;
}

/** Count of flesh-log rows created since `sinceIso` with a given decision. */
export async function countFleshLogSince(
  adapter: DbAdapter,
  opts: { team_id?: string; since_iso: string; decision?: string },
): Promise<number> {
  const params: unknown[] = [opts.team_id ?? "default", opts.since_iso];
  let sql = `SELECT COUNT(*) AS n FROM orchestration_flesh_log WHERE team_id = $1 AND created_at >= $2`;
  if (opts.decision) {
    sql += ` AND decision = $3`;
    params.push(opts.decision);
  }
  const { rows } = await adapter.query<{ n: number }>(sql, params);
  return rows[0] ? Number(rows[0].n) : 0;
}

export interface FleshLogInput {
  item_id: string;
  team_id?: string;
  actor_ref: string;
  source_ref?: string | null;
  input_hash: string;
  output_hash?: string | null;
  decision: string;
  reason: string;
  proposed_patch?: FleshPatch | null;
}

export async function insertFleshLog(adapter: DbAdapter, input: FleshLogInput): Promise<void> {
  const now = new Date().toISOString();
  await adapter.query(
    `INSERT INTO orchestration_flesh_log (
       flesh_log_id, item_id, team_id, actor_ref, source_ref, input_hash, output_hash,
       decision, reason, proposed_patch_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      `coflog_${crypto.randomUUID()}`,
      input.item_id,
      input.team_id ?? "default",
      input.actor_ref,
      input.source_ref ?? null,
      input.input_hash,
      input.output_hash ?? null,
      input.decision,
      input.reason,
      input.proposed_patch ? JSON.stringify(input.proposed_patch) : null,
      now,
    ],
  );
}

export interface FleshLogRow {
  flesh_log_id: string;
  item_id: string;
  actor_ref: string;
  source_ref: string | null;
  input_hash: string;
  output_hash: string | null;
  decision: string;
  reason: string;
  proposed_patch_json: string | null;
  created_at: string;
}

export async function listFleshLog(
  adapter: DbAdapter,
  opts: { team_id?: string; item_id?: string; limit?: number },
): Promise<FleshLogRow[]> {
  const where: string[] = ["team_id = $1"];
  const params: unknown[] = [opts.team_id ?? "default"];
  if (opts.item_id) {
    where.push(`item_id = $${params.length + 1}`);
    params.push(opts.item_id);
  }
  params.push(opts.limit ?? 100);
  const { rows } = await adapter.query<FleshLogRow>(
    `SELECT flesh_log_id, item_id, actor_ref, source_ref, input_hash, output_hash,
            decision, reason, proposed_patch_json, created_at
       FROM orchestration_flesh_log WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// ── Decision log ─────────────────────────────────────────────────────

export async function appendDecisions(
  adapter: DbAdapter,
  opts: { team_id?: string; tick_id: string; dry_run: boolean; records: DecisionRecord[] },
): Promise<void> {
  const now = new Date().toISOString();
  for (const rec of opts.records) {
    await adapter.query(
      `INSERT INTO orchestration_decision_log (
         decision_id, team_id, tick_id, ts, item_id, action, reason, dispatch_phid, dry_run, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        `codec_${crypto.randomUUID()}`,
        opts.team_id ?? "default",
        opts.tick_id,
        now,
        rec.item_id ?? null,
        rec.action,
        rec.reason,
        rec.dispatch_phid ?? null,
        opts.dry_run ? 1 : 0,
        JSON.stringify(rec.metadata ?? {}),
      ],
    );
  }
}

export interface DecisionLogRow {
  decision_id: string;
  tick_id: string;
  ts: string;
  item_id: string | null;
  action: string;
  reason: string;
  dispatch_phid: string | null;
  dry_run: number;
  metadata?: Record<string, unknown>;
}

interface DecisionLogDbRow extends DecisionLogRow {
  metadata_json: string | null;
}

export async function listRecentDecisions(
  adapter: DbAdapter,
  opts: { team_id?: string; limit?: number } = {},
): Promise<DecisionLogRow[]> {
  const { rows } = await adapter.query<DecisionLogDbRow>(
    `SELECT decision_id, tick_id, ts, item_id, action, reason, dispatch_phid, dry_run,
            metadata_json
       FROM orchestration_decision_log WHERE team_id = $1 ORDER BY ts DESC LIMIT $2`,
    [opts.team_id ?? "default", opts.limit ?? 100],
  );
  return rows.map((r) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = r.metadata_json ? JSON.parse(r.metadata_json) : {};
    } catch {
      metadata = {};
    }
    const { metadata_json: _metadata_json, ...rest } = r;
    return { ...rest, metadata };
  });
}

// ── Singleton state ──────────────────────────────────────────────────

export interface OrchestrationState {
  team_id: string;
  mode: OrchestrationMode;
  consecutive_zero_ticks: number;
  last_admission_block_reasons: Record<string, number>;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  auto_paused: boolean;
  auto_pause_reason: string | null;
  updated_at: string;
}

interface StateRow {
  team_id: string;
  mode: string;
  consecutive_zero_ticks: number;
  last_admission_block_reasons_json: string | null;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  auto_paused: number;
  auto_pause_reason: string | null;
  updated_at: string;
}

function parseCountMap(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the team's orchestration state, creating a paused default if absent. */
export async function getOrchestrationState(adapter: DbAdapter, team_id = "default"): Promise<OrchestrationState> {
  const { rows } = await adapter.query<StateRow>(
    `SELECT * FROM orchestration_state WHERE team_id = $1`,
    [team_id],
  );
  if (!rows[0]) {
    const now = new Date().toISOString();
    await adapter.query(
      `INSERT INTO orchestration_state (team_id, mode, updated_at) VALUES ($1, 'paused', $2)
       ON CONFLICT(team_id) DO NOTHING`,
      [team_id, now],
    );
    return {
      team_id,
      mode: "paused",
      consecutive_zero_ticks: 0,
      last_admission_block_reasons: {},
      last_tick_at: null,
      last_dispatch_at: null,
      auto_paused: false,
      auto_pause_reason: null,
      updated_at: now,
    };
  }
  const r = rows[0];
  return {
    team_id: r.team_id,
    mode: r.mode as OrchestrationMode,
    consecutive_zero_ticks: r.consecutive_zero_ticks,
    last_admission_block_reasons: parseCountMap(r.last_admission_block_reasons_json),
    last_tick_at: r.last_tick_at,
    last_dispatch_at: r.last_dispatch_at,
    auto_paused: r.auto_paused === 1,
    auto_pause_reason: r.auto_pause_reason,
    updated_at: r.updated_at,
  };
}

export async function setMode(
  adapter: DbAdapter,
  team_id: string,
  mode: OrchestrationMode,
  opts: { clear_auto_pause?: boolean } = {},
): Promise<void> {
  await getOrchestrationState(adapter, team_id); // ensure row exists
  const now = new Date().toISOString();
  if (opts.clear_auto_pause) {
    await adapter.query(
      `UPDATE orchestration_state
         SET mode = $1, auto_paused = 0, auto_pause_reason = NULL, consecutive_zero_ticks = 0, updated_at = $2
       WHERE team_id = $3`,
      [mode, now, team_id],
    );
  } else {
    await adapter.query(
      `UPDATE orchestration_state SET mode = $1, updated_at = $2 WHERE team_id = $3`,
      [mode, now, team_id],
    );
  }
}

export async function recordTickOutcome(
  adapter: DbAdapter,
  team_id: string,
  opts: {
    zero_ticks: number;
    fired: boolean;
    admission_block_reasons?: Record<string, number>;
    auto_pause?: { reason: string } | null;
  },
): Promise<void> {
  const state = await getOrchestrationState(adapter, team_id);
  const now = new Date().toISOString();
  // Compute the next state in JS (the adapter does not support reusing $N).
  const autoPause = !!opts.auto_pause;
  const newMode = autoPause ? "paused" : state.mode;
  const newAutoPaused = autoPause || state.auto_paused ? 1 : 0;
  const newReason = autoPause ? opts.auto_pause!.reason : state.auto_pause_reason;
  const lastDispatchAt = opts.fired ? now : state.last_dispatch_at;
  await adapter.query(
    `UPDATE orchestration_state
       SET consecutive_zero_ticks = $1,
           last_tick_at = $2,
           last_dispatch_at = $3,
           mode = $4,
           auto_paused = $5,
           auto_pause_reason = $6,
           last_admission_block_reasons_json = $7,
           updated_at = $8
     WHERE team_id = $9`,
    [
      opts.zero_ticks,
      now,
      lastDispatchAt,
      newMode,
      newAutoPaused,
      newReason,
      JSON.stringify(opts.fired ? {} : opts.admission_block_reasons ?? {}),
      now,
      team_id,
    ],
  );
}
