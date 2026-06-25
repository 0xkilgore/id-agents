// T-CKPT.agent-sharing / F4 — share + delegate as FIRST-CLASS actions over the
// Monday seed actor model (src/actor-identity.ts: user:chris / user:liz).
//
// Two grant kinds:
//   - share    — a Monday actor grants ANOTHER Monday actor (a person) access to
//                a subject resource. "share blowout → Liz" = user:chris shares
//                subject project:blowout with user:liz.
//   - delegate — a Monday actor hands a subject off to an AGENT. "delegate to
//                finances" = the actor delegates a subject to agent:finances.
//
// Everything decision-shaped is pure + unit-tested here: validating the granting
// actor (via normalizeActorRef, so only the fixed Monday actors can grant),
// resolving + validating the grantee per kind, shaping the subject ref, and the
// idempotency key. Storage + routes are thin wrappers around buildGrant.

import { normalizeActorRef } from "../actor-identity.js";

export type GrantKind = "share" | "delegate";
export type GranteeKind = "user" | "agent";
/** Access level the grant confers; defaults to "collaborate". */
export type GrantScope = "view" | "collaborate";

export const GRANT_SCOPES: readonly GrantScope[] = ["view", "collaborate"];
export const DEFAULT_GRANT_SCOPE: GrantScope = "collaborate";

/** A persisted share/delegate grant (one row of agent_grants). */
export interface Grant {
  grant_id: string;
  kind: GrantKind;
  /** The granting Monday actor (normalized: user:chris | user:liz). */
  actor_ref: string;
  /** Subject resource kind, e.g. "project" | "artifact" | "domain". */
  subject_kind: string;
  /** Subject resource id within its kind, e.g. "blowout". */
  subject_ref: string;
  /** "user" for a share, "agent" for a delegate. */
  grantee_kind: GranteeKind;
  /** user:liz for a share; the agent name (e.g. "finances") for a delegate. */
  grantee_ref: string;
  scope: GrantScope;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface BuildGrantInput {
  kind: GrantKind;
  actor_ref: unknown;
  subject_kind: unknown;
  subject_ref: unknown;
  /** Grantee: a Monday actor ref for share; an agent name for delegate. */
  grantee_ref: unknown;
  scope?: unknown;
}

export type BuildGrantResult =
  | { ok: true; grant: Grant }
  | { ok: false; code: "invalid"; error: string };

function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Validate a share/delegate request and shape it into a Grant row. Pure.
 *
 * - kind must be "share" or "delegate",
 * - actor_ref must normalize to a fixed Monday actor (the grantor),
 * - subject_kind + subject_ref must both be non-empty (the resource),
 * - share: grantee_ref must normalize to a Monday actor, and must NOT be the
 *   grantor (no self-share),
 * - delegate: grantee_ref is an agent name (non-empty; not a Monday user ref),
 * - scope defaults to "collaborate"; an unknown scope is rejected.
 */
export function buildGrant(
  input: BuildGrantInput,
  nowIso: string,
  idGen: () => string,
): BuildGrantResult {
  if (input.kind !== "share" && input.kind !== "delegate") {
    return { ok: false, code: "invalid", error: 'kind must be "share" or "delegate"' };
  }

  const actorRes = normalizeActorRef(input.actor_ref);
  if (!actorRes.ok) {
    return { ok: false, code: "invalid", error: `actor_ref: ${actorRes.error}` };
  }
  const actor_ref = actorRes.actor.ref;

  const subject_kind = asTrimmed(input.subject_kind);
  const subject_ref = asTrimmed(input.subject_ref);
  if (!subject_kind || !subject_ref) {
    return { ok: false, code: "invalid", error: "subject_kind and subject_ref are required" };
  }

  let scope: GrantScope = DEFAULT_GRANT_SCOPE;
  if (input.scope !== undefined && input.scope !== null && input.scope !== "") {
    if (typeof input.scope !== "string" || !GRANT_SCOPES.includes(input.scope as GrantScope)) {
      return { ok: false, code: "invalid", error: `scope must be one of: ${GRANT_SCOPES.join(", ")}` };
    }
    scope = input.scope as GrantScope;
  }

  let grantee_kind: GranteeKind;
  let grantee_ref: string;
  const granteeRaw = asTrimmed(input.grantee_ref);
  if (!granteeRaw) {
    return { ok: false, code: "invalid", error: "grantee_ref is required" };
  }

  if (input.kind === "share") {
    const granteeRes = normalizeActorRef(input.grantee_ref);
    if (!granteeRes.ok) {
      return { ok: false, code: "invalid", error: `grantee_ref (share target): ${granteeRes.error}` };
    }
    grantee_kind = "user";
    grantee_ref = granteeRes.actor.ref;
    if (grantee_ref === actor_ref) {
      return { ok: false, code: "invalid", error: "cannot share with yourself" };
    }
  } else {
    // delegate → an agent. Reject a Monday user ref here so share vs delegate
    // can't be confused (delegate is for agents, not people).
    if (normalizeActorRef(granteeRaw).ok) {
      return {
        ok: false,
        code: "invalid",
        error: "delegate grantee must be an agent name, not a Monday user (use share for people)",
      };
    }
    grantee_kind = "agent";
    grantee_ref = granteeRaw.replace(/^agent:/, "");
  }

  return {
    ok: true,
    grant: {
      grant_id: idGen(),
      kind: input.kind,
      actor_ref,
      subject_kind,
      subject_ref,
      grantee_kind,
      grantee_ref,
      scope,
      created_at: nowIso,
      revoked_at: null,
      revoked_by: null,
    },
  };
}

/**
 * Stable identity for an ACTIVE grant — used to dedupe re-shares/re-delegates of
 * the same (kind, subject, grantee) by the same actor. Excludes scope so raising
 * a view→collaborate scope is an update, not a duplicate. Pure.
 */
export function grantIdentityKey(
  g: Pick<Grant, "kind" | "actor_ref" | "subject_kind" | "subject_ref" | "grantee_kind" | "grantee_ref">,
): string {
  return [g.kind, g.actor_ref, g.subject_kind, g.subject_ref, g.grantee_kind, g.grantee_ref].join("|");
}

/**
 * Who may revoke a grant: the granting actor, or user:chris (the owner-actor)
 * as an administrative override. Pure. `actorRefInput` is normalized first; an
 * unknown actor can never revoke.
 */
export function canRevoke(grant: Pick<Grant, "actor_ref">, actorRefInput: unknown): boolean {
  const res = normalizeActorRef(actorRefInput);
  if (!res.ok) return false;
  return res.actor.ref === grant.actor_ref || res.actor.ref === "user:chris";
}
