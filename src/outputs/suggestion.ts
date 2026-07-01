// Artifact Review v1 — suggested-change model (Roger / substrate slice).
//
// Contract: cto/output/2026-06-29-suggested-change-route-contract.md
// (relates_to 2026-06-26-artifact-review-v1-spec §1.5 Suggestion + apply).
//
// A "suggested change" is a comment-subtype that carries a concrete span edit.
// It invents almost nothing: it reuses the artifact-comment classifier/router
// on its `rationale` and reuses the existing append-only `edit` op (edit.ts) as
// its apply — the source file is NEVER mutated, so an accept is reversible.
//
// This module is the PURE spine (mirrors edit.ts's latestEdit derivation):
//   • the `suggestion` op_type + payload (de)serialization,
//   • the append-only lifecycle reconstruction (proposed → accepted/rejected/
//     superseded/stale), current state derived from the latest op,
//   • the span-apply + drift guard (pure; no DB / no filesystem).
// The op writes + HTTP wiring live in ops.ts / routes.ts.

import { randomBytes } from "node:crypto";
import type { ArtifactOpRow } from "./types.js";

/** Op-log type for a suggested change (sibling to `comment_recorded` + `edit`).
 *  Distinct from the v0 `suggested_change` op (a free-form suggestion comment):
 *  a `suggestion` op carries original_text/proposed_text + a lifecycle state and
 *  is applied via the reversible `edit` op. */
export const SUGGESTION_OP_TYPE = "suggestion" as const;

export const SUGGESTION_SCHEMA_VERSION = "artifact.suggestion.v1" as const;

/** Lifecycle state machine on a suggestion_id (contract §3). Each transition is
 *  an append-only op; the current state is the latest. */
export type SuggestionState =
  | "proposed"
  | "accepted"
  | "rejected"
  | "superseded"
  | "stale";

/** A one-tap reaction carried alongside the rationale (parity with comments). */
export type SuggestionReaction = "ship_it" | "wrong" | "explain" | "iterate";

/** Span anchor Regina renders against. Only `char_start`/`char_end` +
 *  `original_text` are load-bearing for apply; the rest are drift-tolerant
 *  render hints (contract §1). */
export interface SuggestionAnchor {
  kind: "span";
  quote: string;
  char_start: number;
  char_end: number;
  heading_path?: string[] | null;
}

/** The durable suggestion record, reconstructed from the op-log. */
export interface SuggestionRecord {
  suggestion_id: string;
  artifact_id: string;
  state: SuggestionState;
  anchor: SuggestionAnchor;
  original_text: string;
  proposed_text: string;
  author: string;                       // actor ref ("user:chris" | "agent:<name>")
  rationale: string;
  reaction: SuggestionReaction | null;
  created_at: string;
  updated_at: string;
  /** The `edit` op this suggestion was applied as, once accepted. */
  applied_edit_op_id: number | null;
  /** Reject reason / supersede pointer, when in that terminal state. */
  reason: string | null;
  superseded_by: string | null;
}

/** The create-time fields Regina sends (contract §1). */
export interface SuggestionCreateInput {
  anchor: SuggestionAnchor;
  original_text: string;
  proposed_text: string;
  author: string;                       // actor ref ("user:chris" | "agent:<name>")
  rationale: string;
  reaction?: SuggestionReaction | null;
}

/** Server-minted, stable suggestion id (RD-001 target for all later ops).
 *  Mirrors the dispatch phid shape (`phid:disp-<hex>`). */
export function mintSuggestionId(): string {
  return `phid:sug-${randomBytes(8).toString("hex")}`;
}

// ── Op payloads ─────────────────────────────────────────────────────
// A create op carries the full suggestion; a transition op carries only the
// state change + linkage. Both are `suggestion` ops keyed by suggestion_id.

interface SuggestionCreatePayload {
  op: "create";
  schema_version: typeof SUGGESTION_SCHEMA_VERSION;
  suggestion_id: string;
  anchor: SuggestionAnchor;
  original_text: string;
  proposed_text: string;
  rationale: string;
  reaction: SuggestionReaction | null;
  state: "proposed";
}

interface SuggestionTransitionPayload {
  op: "transition";
  schema_version: typeof SUGGESTION_SCHEMA_VERSION;
  suggestion_id: string;
  state: Exclude<SuggestionState, "proposed">;
  applied_edit_op_id?: number | null;
  reason?: string | null;
  superseded_by?: string | null;
}

export function buildSuggestionCreatePayload(
  suggestionId: string,
  input: SuggestionCreateInput,
): string {
  const payload: SuggestionCreatePayload = {
    op: "create",
    schema_version: SUGGESTION_SCHEMA_VERSION,
    suggestion_id: suggestionId,
    anchor: input.anchor,
    original_text: input.original_text,
    proposed_text: input.proposed_text,
    rationale: input.rationale,
    reaction: input.reaction ?? null,
    state: "proposed",
  };
  return JSON.stringify(payload);
}

export function buildSuggestionTransitionPayload(
  suggestionId: string,
  state: Exclude<SuggestionState, "proposed">,
  extra: { applied_edit_op_id?: number | null; reason?: string | null; superseded_by?: string | null } = {},
): string {
  const payload: SuggestionTransitionPayload = {
    op: "transition",
    schema_version: SUGGESTION_SCHEMA_VERSION,
    suggestion_id: suggestionId,
    state,
    applied_edit_op_id: extra.applied_edit_op_id ?? null,
    reason: extra.reason ?? null,
    superseded_by: extra.superseded_by ?? null,
  };
  return JSON.stringify(payload);
}

// ── Reconstruction (pure; mirrors edit.ts latestEdit) ───────────────

function parsePayload(op: ArtifactOpRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(op.payload_json ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reconstruct one suggestion from the artifact op-log: the `create` op seeds the
 * record; every later `transition` op for the same suggestion_id (in op_id
 * order) advances the state + linkage. Returns null when the id was never
 * created. Pure — the read/accept routes are thin adapters over listOperations.
 */
export function reconstructSuggestion(
  ops: ArtifactOpRow[],
  artifactId: string,
  suggestionId: string,
): SuggestionRecord | null {
  const relevant = ops
    .filter((op) => op.op_type === SUGGESTION_OP_TYPE)
    .filter((op) => (parsePayload(op)?.suggestion_id as string | undefined) === suggestionId)
    .sort((a, b) => a.op_id - b.op_id);

  const createOp = relevant.find((op) => parsePayload(op)?.op === "create");
  if (!createOp) return null;
  const create = parsePayload(createOp) as unknown as SuggestionCreatePayload;

  const record: SuggestionRecord = {
    suggestion_id: suggestionId,
    artifact_id: artifactId,
    state: "proposed",
    anchor: create.anchor,
    original_text: create.original_text,
    proposed_text: create.proposed_text,
    author: createOp.actor,
    rationale: create.rationale,
    reaction: create.reaction ?? null,
    created_at: createOp.ts,
    updated_at: createOp.ts,
    applied_edit_op_id: null,
    reason: null,
    superseded_by: null,
  };

  for (const op of relevant) {
    const p = parsePayload(op);
    if (!p || p.op !== "transition") continue;
    record.state = p.state as SuggestionState;
    record.updated_at = op.ts;
    if (typeof p.applied_edit_op_id === "number") record.applied_edit_op_id = p.applied_edit_op_id;
    if (typeof p.reason === "string") record.reason = p.reason;
    if (typeof p.superseded_by === "string") record.superseded_by = p.superseded_by;
  }
  return record;
}

/** All suggestions on an artifact, newest-created first. */
export function reconstructSuggestions(ops: ArtifactOpRow[], artifactId: string): SuggestionRecord[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op_type !== SUGGESTION_OP_TYPE) continue;
    const id = parsePayload(op)?.suggestion_id as string | undefined;
    if (id) ids.add(id);
  }
  const out: SuggestionRecord[] = [];
  for (const id of ids) {
    const rec = reconstructSuggestion(ops, artifactId, id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ── Span apply + drift guard (pure) ─────────────────────────────────

export type SpanApplyResult =
  | { ok: true; next_body: string; char_start: number; char_end: number }
  | { ok: false; reason: "drift" };

/** Resolve WHERE original_text currently sits in the body, guarding drift.
 *  Returns null (drifted) when it cannot be located unambiguously. */
function resolveSpan(
  currentBody: string,
  originalText: string,
  anchor: Pick<SuggestionAnchor, "char_start" | "char_end">,
): { start: number; end: number } | null {
  const { char_start, char_end } = anchor;
  // 1. Anchor offsets still valid — the text there is exactly original_text.
  if (
    Number.isInteger(char_start) &&
    Number.isInteger(char_end) &&
    char_start >= 0 &&
    char_end <= currentBody.length &&
    char_start <= char_end &&
    currentBody.slice(char_start, char_end) === originalText
  ) {
    return { start: char_start, end: char_end };
  }
  // 2. Re-find, but only when original_text occurs EXACTLY ONCE (offset drift
  //    from reflow is fine; an ambiguous match must NOT silently pick a span).
  const first = currentBody.indexOf(originalText);
  if (first === -1) return null;
  if (first !== currentBody.lastIndexOf(originalText)) return null;
  return { start: first, end: first + originalText.length };
}

/**
 * Apply a suggestion's span edit to `currentBody`, guarding against drift
 * (contract §3 "drift guard first"). Never mutates input; returns the would-be
 * new full body for the reversible `edit` op, or `{ ok:false, reason:"drift" }`
 * when original_text can no longer be located unambiguously (caller → 409 +
 * marks the suggestion stale, NO edit written).
 */
export function applySuggestionSpan(
  currentBody: string,
  originalText: string,
  proposedText: string,
  anchor: Pick<SuggestionAnchor, "char_start" | "char_end">,
): SpanApplyResult {
  const span = resolveSpan(currentBody, originalText, anchor);
  if (!span) return { ok: false, reason: "drift" };
  return {
    ok: true,
    next_body: currentBody.slice(0, span.start) + proposedText + currentBody.slice(span.end),
    char_start: span.start,
    char_end: span.end,
  };
}
