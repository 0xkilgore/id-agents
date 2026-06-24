// T-CKPT.8 — Edit-in-product (Connect T2), phase-1 slice.
//
// The safest reversible edit slice: an operator's in-place edit of an artifact
// is captured as an append-only `edit` op in the artifact op-log. The SOURCE
// FILE IS NEVER MUTATED here — the edited body lives only in the substrate, so
// the change is fully reversible (the canonical file is untouched and the edit
// is just one more op row). A later phase reconciles edits back to the file /
// Powerhouse Connect substrate (the TC-1 eval). The whole capability is behind a
// flag so it is a no-op until explicitly enabled.

import type { ArtifactOpRow } from "./types.js";
import type { ActorRef } from "./entry.js";
import { parseActorRef } from "./entry-projection.js";

/** Op-log type for an in-product edit. */
export const EDIT_OP_TYPE = "edit" as const;

/** Edit-in-product capability flag (reversible cutover). When OFF the write
 *  endpoint 404s and nothing is recorded; reads simply find no edit. */
export function isEditInProductEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.ARTIFACTS_EDIT_IN_PRODUCT ?? "").trim());
}

export interface ArtifactEdit {
  content: string;
  note: string | null;
  editor: ActorRef;
  edited_at: string;
}

/** Serialize an edit's content (+ optional note) for the op-log payload. */
export function buildEditPayload(content: string, note: string | null): string {
  return JSON.stringify(note ? { content, note } : { content });
}

/**
 * The latest in-product edit for an artifact, derived from its op-log (the most
 * recent `edit` op by op_id). Returns null when the artifact has never been
 * edited. Pure — the read route is a thin adapter over listOperations().
 */
export function latestEdit(ops: ArtifactOpRow[]): ArtifactEdit | null {
  let latest: ArtifactOpRow | null = null;
  for (const op of ops) {
    if (op.op_type !== EDIT_OP_TYPE) continue;
    if (!latest || op.op_id > latest.op_id) latest = op;
  }
  if (!latest) return null;

  let content = "";
  let note: string | null = null;
  try {
    const parsed = JSON.parse(latest.payload_json ?? "{}") as { content?: unknown; note?: unknown };
    if (typeof parsed.content === "string") content = parsed.content;
    if (typeof parsed.note === "string") note = parsed.note;
  } catch {
    /* malformed payload → empty edit body */
  }
  return { content, note, editor: parseActorRef(latest.actor), edited_at: latest.ts };
}
