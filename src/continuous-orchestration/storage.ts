// Continuous Orchestration — sqlite persistence.
//
// CRUD for the backlog, the append-only decision log, and the singleton
// per-team orchestration state. Pure SQL over the shared DbAdapter; the daemon
// + routes layer the policy on top.

import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type {
  BacklogItem,
  DecisionRecord,
  FleshPatch,
  FleshStatus,
  OrchestrationMode,
  ReadinessState,
  RiskClass,
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
       provider, runtime, is_north_star, source_refs_json, track_drift, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
 * The human/approval gate: promote a draft/needs_review item to READY. Refuses
 * to promote from any other state, and refuses items with no dispatch body/agent
 * (they would never be admissible).
 */
export async function promoteToReady(
  adapter: DbAdapter,
  item_id: string,
  approved_by: string,
): Promise<{ ok: boolean; reason?: string; item?: BacklogItem }> {
  const item = await getBacklogItem(adapter, item_id);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.readiness_state !== "draft" && item.readiness_state !== "needs_review") {
    return { ok: false, reason: `cannot promote from ${item.readiness_state}` };
  }
  if (!item.to_agent || !item.dispatch_body) {
    return { ok: false, reason: "missing to_agent or dispatch_body" };
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
       SET readiness_state = 'ready', approved_by = $1, approved_at = $2, updated_at = $3
     WHERE item_id = $4`,
    [approved_by, now, now, item_id],
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
  // human explicitly set (signalled by `updated_by`, which only the field-PATCH
  // endpoint sets — the flesher never does), preserving Claude-Light lane routing.
  const operatorRouted = item.updated_by != null;

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
    // Routing fields are sticky: keep an operator/human-set to_agent + priority
    // (sticky-routing guard above) instead of resetting it to the flesher's pick.
    if (!operatorRouted) {
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
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  auto_paused: number;
  auto_pause_reason: string | null;
  updated_at: string;
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
           updated_at = $7
     WHERE team_id = $8`,
    [opts.zero_ticks, now, lastDispatchAt, newMode, newAutoPaused, newReason, now, team_id],
  );
}
