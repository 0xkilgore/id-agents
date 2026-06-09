// Kapelle B11 manager-side backend foundation — outputs/ops.ts
//
// Mutation handlers used by routes.ts: viewArtifact, approveArtifact,
// shipArtifact. Each mutation:
//   1. Lazily creates (or updates) the artifact_review_state row.
//   2. Appends an artifact_operations row.
//   3. Returns enough state for the route to send a response.
//
// Ship is a STUB until executors exist. It returns explicit blocker
// codes so callers know exactly what's missing. The same call signature
// will return status:"ok" once those executors land — no API break.

import type { DbAdapter } from "../db/db-adapter.js";
import { appendOperation, getReviewState, upsertReviewState } from "./storage.js";
import type {
  ApproveRequest,
  ArtifactOpType,
  ArtifactReviewStateRow,
  ShipRequest,
  ShipResponse,
  ViewRequest,
} from "./types.js";

const DEFAULT_ACTOR = "operator";

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

export interface ViewResult {
  state: ArtifactReviewStateRow;
  op_id: number;
}

export async function viewArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ViewRequest,
  now?: () => Date,
): Promise<ViewResult> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const viewer = (req.viewer || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const patch: Partial<ArtifactReviewStateRow> = {
    last_viewed_at: ts,
    viewed_by_last: viewer,
    viewed_count: (existing?.viewed_count ?? 0) + 1,
    first_viewed_at: existing?.first_viewed_at ?? ts,
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "view",
    viewer,
    ts,
    JSON.stringify({ viewed_count_after: state.viewed_count }),
    state.source_link,
  );
  return { state, op_id: opId };
}

export interface ApproveResult {
  state: ArtifactReviewStateRow;
  op_id: number;
}

export async function approveArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ApproveRequest,
  now?: () => Date,
): Promise<ApproveResult> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const approver = (req.approver || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const patch: Partial<ArtifactReviewStateRow> = {
    approved_at: existing?.approved_at ?? ts, // first-approve wins for the timestamp
    approved_by: approver,
    approval_note: req.note ?? existing?.approval_note ?? null,
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    "approve",
    approver,
    ts,
    JSON.stringify({ note: req.note ?? null }),
    state.source_link,
  );
  return { state, op_id: opId };
}

// Blocker codes returned by /ship. Stable enum-style strings; clients
// match against these to render UX. Adding new codes is backwards-
// compatible; removing one is not.
export const SHIP_BLOCKERS = {
  NO_EXECUTOR: "no_executor_configured",
  NOT_APPROVED: "artifact_not_approved",
  ALREADY_SHIPPED: "already_shipped",
} as const;

export type ShipBlockerCode = (typeof SHIP_BLOCKERS)[keyof typeof SHIP_BLOCKERS];

// Returns the current blocker set for an artifact. Pure (no I/O beyond
// the existing state). Today every ship returns NO_EXECUTOR because
// no executor is wired; that's intentional. The order matters:
// ALREADY_SHIPPED checks first, NOT_APPROVED next, NO_EXECUTOR last.
// When executors land, this function becomes the single place to
// remove NO_EXECUTOR from the static blocker list.
export function computeShipBlockers(state: ArtifactReviewStateRow | null): ShipBlockerCode[] {
  const blockers: ShipBlockerCode[] = [];
  if (state?.shipped_at) blockers.push(SHIP_BLOCKERS.ALREADY_SHIPPED);
  if (!state?.approved_at) blockers.push(SHIP_BLOCKERS.NOT_APPROVED);
  // Stub: no executor is configured yet. This is the canonical "until
  // executors exist" blocker the dispatch requested.
  blockers.push(SHIP_BLOCKERS.NO_EXECUTOR);
  return blockers;
}

export async function shipArtifact(
  adapter: DbAdapter,
  artifactId: string,
  req: ShipRequest,
  now?: () => Date,
): Promise<ShipResponse> {
  const ts = nowIso(now);
  const existing = await getReviewState(adapter, artifactId);
  const shipper = (req.shipper || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  const blockers = computeShipBlockers(existing);

  // Always record the attempt as an operation, even when blocked.
  const blocked = blockers.length > 0;
  const opType: ArtifactOpType = blocked ? "ship_blocked" : "ship_attempted";
  const patch: Partial<ArtifactReviewStateRow> = {
    source_link: req.source_link ?? existing?.source_link ?? null,
  };
  if (blocked) {
    patch.ship_blockers_json = JSON.stringify(blockers);
  } else {
    // Future: this path lights up when executors exist.
    patch.shipped_at = ts;
    patch.shipped_by = shipper;
    patch.ship_blockers_json = null;
  }
  const state = await upsertReviewState(adapter, artifactId, patch, ts);
  const opId = await appendOperation(
    adapter,
    artifactId,
    opType,
    shipper,
    ts,
    JSON.stringify({ blockers, attempted_by: shipper }),
    state.source_link,
  );

  return {
    schema_version: "artifact.ship.v1",
    artifact_id: artifactId,
    status: blocked ? "blocked" : "ok",
    blockers,
    message: blocked
      ? `Ship blocked by: ${blockers.join(", ")}. Recorded as operation #${opId}.`
      : `Ship recorded. Op #${opId}.`,
    recorded_op_id: opId,
  };
}
