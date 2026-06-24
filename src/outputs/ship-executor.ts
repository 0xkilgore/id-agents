// CANE_DRAFT_ARTIFACTS — the send executor for cane_draft artifacts.
//
// This is the ONE place the `ship` action turns from a stub into a real send,
// and ONLY for the cane_draft kind. The executor does NOT re-implement SMTP: it
// resolves the artifact's draft_id and calls the single Cane send endpoint
//   POST {CANE_BASE_URL}/drafts/<pending_id>/send  { body_markdown: <latest> }
// so every surface (console, CLI, Telegram) converges on one send path and a
// cross-surface race can never double-send (Cane is idempotent on pending_id).
//
// The HTTP sender is INJECTABLE so tests never hit the network. Production wires
// `defaultCaneDraftSender(CANE_BASE_URL)`.

import type { CaneDraftPayload } from "./types.js";

/** Evidence returned by Cane's /drafts/:id/send on a successful (or already-
 *  sent) send. message_id is the idempotency anchor on Cane's side. */
export interface CaneSendEvidence {
  sent_at: string;
  message_id: string;
  final_reply?: string;
  /** Cane already sent this draft (idempotent replay) — not a new email. */
  already_sent?: boolean;
}

export interface CaneSendResult {
  ok: boolean;
  evidence?: CaneSendEvidence;
  error?: string;
}

/** Injectable sender: given a draft payload + the latest body to send, performs
 *  the actual Cane send and returns evidence. Pure transport — no DB writes. */
export type CaneDraftSender = (
  payload: CaneDraftPayload,
  bodyMarkdown: string,
) => Promise<CaneSendResult>;

/** Resolve the Cane pending_id from a draft_id ("cane:draft:<pending_id>").
 *  Returns the trailing segment; falls back to the whole id if unprefixed. */
export function pendingIdFromDraftId(draftId: string): string {
  const m = /^cane:draft:(.+)$/.exec(draftId);
  return m ? m[1] : draftId;
}

/** Default base URL for the Cane send endpoint. Overridable via CANE_BASE_URL. */
export function caneBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CANE_BASE_URL?.trim() || "http://localhost:8765").replace(/\/+$/, "");
}

/** Production sender — POSTs to Cane's single send path over HTTP. Network
 *  failures + non-2xx responses come back as { ok:false, error } so the ship
 *  handler records a blocked attempt rather than throwing. */
export function defaultCaneDraftSender(
  baseUrl: string = caneBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): CaneDraftSender {
  return async (payload, bodyMarkdown) => {
    const pendingId = pendingIdFromDraftId(payload.draft_id);
    const url = `${baseUrl}/drafts/${encodeURIComponent(pendingId)}/send`;
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_markdown: bodyMarkdown }),
      });
      const text = await resp.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      if (!resp.ok) {
        const errMsg =
          (parsed as { error?: string })?.error ?? `cane send failed (HTTP ${resp.status})`;
        return { ok: false, error: errMsg };
      }
      const p = parsed as Partial<CaneSendEvidence>;
      if (!p.message_id || !p.sent_at) {
        return { ok: false, error: "cane send response missing sent_at/message_id" };
      }
      return {
        ok: true,
        evidence: {
          sent_at: p.sent_at,
          message_id: p.message_id,
          final_reply: p.final_reply,
          already_sent: p.already_sent,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
