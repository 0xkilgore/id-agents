import { createHash } from "node:crypto";
import type {
  ReviewNextAction,
  ReviewNextFreshnessState,
  ReviewNextLifecycle,
  ReviewNextResponse,
  ReviewNextRow,
  ReviewNextSourceRow,
} from "./types.js";

export const REVIEW_NEXT_MAX_ROWS = 5;
export const REVIEW_NEXT_MAX_BYTES = 64 * 1024;
export const REVIEW_NEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_NEXT_FRESH_AGE_MS = 72 * 60 * 60 * 1000;
export const REVIEW_NEXT_REVALIDATION_AGE_MS = 24 * 60 * 60 * 1000;

const ELIGIBLE_LIFECYCLES = new Set<ReviewNextLifecycle>(["active", "open", "needs_review", "pending"]);
const KNOWN_ACTIONS = new Set<ReviewNextAction>([
  "open",
  "acknowledge",
  "comment",
  "approve",
  "request_change",
  "route",
  "react",
]);
const TEST_PATH_SEGMENT = /(?:^|[\\/])(?:test|tests|fixture|fixtures|src)(?:[\\/]|$)/i;

export interface BuildReviewNextOptions {
  now?: Date;
  supportedActions?: ReadonlySet<ReviewNextAction>;
  freshnessState?: ReviewNextResponse["freshness_state"];
  freshnessReason?: string;
}

export function buildReviewNextResponse(
  sourceRows: readonly ReviewNextSourceRow[],
  options: BuildReviewNextOptions = {},
): ReviewNextResponse {
  const now = options.now ?? new Date();
  const supportedActions = options.supportedActions ?? KNOWN_ACTIONS;
  const rows = sourceRows
    .map((row) => admitReviewNextRow(row, now, supportedActions))
    .filter((row): row is ReviewNextRow => row !== null)
    .sort(compareReviewNextRows)
    .slice(0, REVIEW_NEXT_MAX_ROWS);
  const sourceCursor = createHash("sha256")
    .update(rows.map((row) => `${row.id}\u0000${row.meaningful_at}\u0000${row.pinned ? 1 : 0}\u0000${row.attention_priority}`).join("\n"))
    .digest("hex");
  const sourceAsOf = rows.reduce<string | null>((latest, row) => !latest || row.source_as_of > latest ? row.source_as_of : latest, null);
  const response: ReviewNextResponse = {
    ok: true,
    schema_version: "review-next.v1",
    authority: {
      owner: "manager",
      projection: "review_next",
      state: "authoritative",
      source_cursor: `sha256:${sourceCursor}`,
    },
    projection_as_of: now.toISOString(),
    source_as_of: sourceAsOf,
    freshness_state: options.freshnessState ?? "current",
    freshness_reason: bounded(options.freshnessReason ?? "manager projection queried from explicit artifact registration metadata", 240),
    rows,
    count: rows.length,
    max_rows: REVIEW_NEXT_MAX_ROWS,
    payload_bytes: 0,
  };
  response.payload_bytes = stablePayloadBytes(response);
  if (response.payload_bytes > REVIEW_NEXT_MAX_BYTES) {
    throw new Error(`review_next_payload_exceeds_${REVIEW_NEXT_MAX_BYTES}_bytes`);
  }
  return response;
}

export function admitReviewNextRow(
  row: ReviewNextSourceRow,
  now: Date,
  supportedActions: ReadonlySet<ReviewNextAction> = KNOWN_ACTIONS,
): ReviewNextRow | null {
  if (row.audience !== "operator" || row.environment !== "production") return null;
  if (!row.artifact_id || !row.title?.trim() || !row.owner?.trim() || !row.canonical_url?.trim()) return null;
  if (!validTimestamp(row.artifact_created_at) || !validTimestamp(row.source_as_of)) return null;
  if (row.availability !== "present") return null;
  if (row.source !== "agent-done" && row.source !== "manual") return null;
  if (TEST_PATH_SEGMENT.test(row.abs_path) || TEST_PATH_SEGMENT.test(row.basename)) return null;
  if (!ELIGIBLE_LIFECYCLES.has(row.effective_lifecycle as ReviewNextLifecycle)) return null;

  const sourceMs = Date.parse(row.source_as_of);
  const revisedMs = timestampOrNull(row.revised_at);
  const revalidatedMs = timestampOrNull(row.revalidated_at);
  const pinned = timestampOrNull(row.pinned_at) !== null;
  const revisionMeaningfulMs = Math.max(sourceMs, revisedMs ?? Number.NEGATIVE_INFINITY);
  const sourceAgeMs = now.getTime() - sourceMs;
  const explicitlyRevalidated = revalidatedMs !== null
    && sourceAgeMs > REVIEW_NEXT_MAX_AGE_MS
    && now.getTime() - revalidatedMs <= REVIEW_NEXT_REVALIDATION_AGE_MS
    && now.getTime() - revalidatedMs >= 0;
  const meaningfulMs = explicitlyRevalidated
    ? revalidatedMs as number
    : Math.max(revisionMeaningfulMs, sourceAgeMs <= REVIEW_NEXT_MAX_AGE_MS ? revalidatedMs ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY);
  const ageMs = now.getTime() - meaningfulMs;
  if (!pinned && !explicitlyRevalidated && (ageMs < 0 || ageMs > REVIEW_NEXT_MAX_AGE_MS)) return null;

  const freshness = rowFreshness({ pinned, explicitlyRevalidated, sourceAgeMs, ageMs, revisedMs, sourceMs });
  const permittedActions = parseActions(row.permitted_actions_json)
    .filter((action) => supportedActions.has(action));
  if (!permittedActions.includes("open")) permittedActions.unshift("open");

  return {
    id: bounded(row.artifact_id, 256),
    canonical_url: bounded(row.canonical_url, 2048),
    title: bounded(row.title.trim(), 512),
    owner: bounded(row.owner.trim(), 128),
    audience: "operator",
    admission_reason: bounded(row.admission_reason, 240),
    attention_state: bounded(row.attention_state, 64),
    attention_reason: bounded(row.attention_reason, 240),
    attention_priority: normalizePriority(row.attention_priority),
    effective_lifecycle: row.effective_lifecycle as ReviewNextLifecycle,
    created_at: row.artifact_created_at,
    source_as_of: row.source_as_of,
    meaningful_at: new Date(meaningfulMs).toISOString(),
    freshness_state: freshness.state,
    freshness_reason: freshness.reason,
    pinned,
    permitted_actions: permittedActions,
  };
}

export function compareReviewNextRows(a: ReviewNextRow, b: ReviewNextRow): number {
  return Number(b.pinned) - Number(a.pinned)
    || a.attention_priority - b.attention_priority
    || b.meaningful_at.localeCompare(a.meaningful_at)
    || a.id.localeCompare(b.id);
}

function rowFreshness(input: {
  pinned: boolean;
  explicitlyRevalidated: boolean;
  sourceAgeMs: number;
  ageMs: number;
  revisedMs: number | null;
  sourceMs: number;
}): { state: ReviewNextFreshnessState; reason: string } {
  if (input.pinned) return { state: "pinned", reason: "explicit pin bypasses default seven-day expiry" };
  if (input.explicitlyRevalidated) return { state: "revalidated", reason: "older decision explicitly revalidated within 24 hours" };
  if (input.revisedMs !== null && input.revisedMs > input.sourceMs) {
    return { state: "revised", reason: "meaningful revision is within the seven-day eligibility window" };
  }
  if (input.ageMs <= REVIEW_NEXT_FRESH_AGE_MS) return { state: "fresh", reason: "source is at most 72 hours old" };
  return { state: "aging", reason: "source is older than 72 hours but within the seven-day eligibility window" };
}

function parseActions(raw: string): ReviewNextAction[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is ReviewNextAction => typeof value === "string" && KNOWN_ACTIONS.has(value as ReviewNextAction)))];
  } catch {
    return [];
  }
}

function normalizePriority(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(999, Math.trunc(value))) : 999;
}

function timestampOrNull(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validTimestamp(value: string): boolean {
  return timestampOrNull(value) !== null;
}

function bounded(value: string, max: number): string {
  return value.slice(0, max);
}

function stablePayloadBytes(response: ReviewNextResponse): number {
  let previous = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(JSON.stringify(response), "utf8");
    response.payload_bytes = next;
    if (next === previous) return next;
    previous = next;
  }
  return Buffer.byteLength(JSON.stringify(response), "utf8");
}
