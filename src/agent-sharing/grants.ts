// T-CKPT.agent-sharing/F4 — agent sharing/delegation grants.
//
// Liz's unprompted ask (liz-feedback-triage-v1 AI-3): make the Monday seed model
// (share blowout→Liz, delegate-to-finances) a real, first-class action instead of
// hand-rolled config. A GRANT records that one operator (grantor) gave another
// (grantee) access to an agent, in one of two modes:
//
//   - share    → VISIBILITY: the grantee can see the agent + its work.
//   - delegate → ACT-AS: the grantee can also dispatch / act through the agent.
//
// Cross-org sharing is intentionally OUT of scope (that is the long-horizon agent
// marketplace). Both actors are validated against the fixed Monday actor set.
//
// Pure policy (decisions) is split from the I/O (persistence) so the access rules
// are unit-testable without a DB, mirroring the rest of the codebase.

import crypto from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import { normalizeActorRef, type MondayActorRef } from "../actor-identity.js";

export type GrantKind = "share" | "delegate";

export interface AgentGrant {
  id: string;
  team_id: string;
  agent_id: string;
  grantor_actor_ref: MondayActorRef;
  grantee_actor_ref: MondayActorRef;
  grant_kind: GrantKind;
  created_at: number;
  revoked_at: number | null;
}

/** Normalize a client-supplied grant kind. Pure; null when invalid. */
export function normalizeGrantKind(input: unknown): GrantKind | null {
  if (typeof input !== "string") return null;
  const k = input.trim().toLowerCase();
  return k === "share" || k === "delegate" ? k : null;
}

/** An active grant is one that has not been revoked. Pure. */
export function isActiveGrant(grant: Pick<AgentGrant, "revoked_at">): boolean {
  return grant.revoked_at == null;
}

/**
 * VISIBILITY: can this actor see the agent? True when any active grant (share OR
 * delegate) names them as grantee. Grantors implicitly retain their own access
 * (they are not re-listed as grantees here — ownership is enforced elsewhere).
 * Pure.
 */
export function actorCanView(grants: AgentGrant[], actorRef: string): boolean {
  return grants.some((g) => isActiveGrant(g) && g.grantee_actor_ref === actorRef);
}

/**
 * ACT-AS: can this actor dispatch/act through the agent? True only when an active
 * DELEGATE grant names them as grantee (a plain share confers visibility only).
 * Pure.
 */
export function actorCanDelegate(grants: AgentGrant[], actorRef: string): boolean {
  return grants.some(
    (g) => isActiveGrant(g) && g.grant_kind === "delegate" && g.grantee_actor_ref === actorRef,
  );
}

export type GrantValidationError =
  | { code: "invalid_actor"; field: "grantor" | "grantee"; error: string }
  | { code: "invalid_grant_kind"; error: string }
  | { code: "self_grant"; error: string };

export interface ValidatedGrantInput {
  grantor_actor_ref: MondayActorRef;
  grantee_actor_ref: MondayActorRef;
  grant_kind: GrantKind;
}

/**
 * Validate a grant request against the fixed Monday actor set + kind enum, and
 * reject self-grants (granting yourself access is a no-op). Pure: returns either
 * the normalized input or the first typed error.
 */
export function validateGrantInput(input: {
  grantor: unknown;
  grantee: unknown;
  grant_kind: unknown;
}): { ok: true; value: ValidatedGrantInput } | { ok: false; error: GrantValidationError } {
  const grantor = normalizeActorRef(input.grantor);
  if (!grantor.ok) {
    return { ok: false, error: { code: "invalid_actor", field: "grantor", error: grantor.error } };
  }
  const grantee = normalizeActorRef(input.grantee);
  if (!grantee.ok) {
    return { ok: false, error: { code: "invalid_actor", field: "grantee", error: grantee.error } };
  }
  const grant_kind = normalizeGrantKind(input.grant_kind);
  if (!grant_kind) {
    return {
      ok: false,
      error: { code: "invalid_grant_kind", error: "grant_kind must be 'share' or 'delegate'" },
    };
  }
  if (grantor.actor.ref === grantee.actor.ref) {
    return { ok: false, error: { code: "self_grant", error: "cannot grant an agent to yourself" } };
  }
  return {
    ok: true,
    value: {
      grantor_actor_ref: grantor.actor.ref,
      grantee_actor_ref: grantee.actor.ref,
      grant_kind,
    },
  };
}

/** Who may list an agent's grants: user:chris sees all; others see only grants
 *  where they are the grantor or grantee. Pure. */
export function visibleGrantsFor(grants: AgentGrant[], actorRef: string): AgentGrant[] {
  if (actorRef === "user:chris") return grants;
  return grants.filter((g) => g.grantor_actor_ref === actorRef || g.grantee_actor_ref === actorRef);
}

/** Who may revoke a grant: the original grantor, or user:chris. Pure. */
export function canRevokeGrant(grant: AgentGrant, actorRef: string): boolean {
  return actorRef === "user:chris" || grant.grantor_actor_ref === actorRef;
}

// ─────────────────────────── persistence (I/O) ───────────────────────────

interface AgentGrantRow {
  id: string;
  team_id: string;
  agent_id: string;
  grantor_actor_ref: string;
  grantee_actor_ref: string;
  grant_kind: string;
  created_at: number;
  revoked_at: number | null;
}

function rowToGrant(row: AgentGrantRow): AgentGrant {
  return {
    id: row.id,
    team_id: row.team_id,
    agent_id: row.agent_id,
    grantor_actor_ref: row.grantor_actor_ref as MondayActorRef,
    grantee_actor_ref: row.grantee_actor_ref as MondayActorRef,
    grant_kind: row.grant_kind as GrantKind,
    created_at: Number(row.created_at),
    revoked_at: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

export interface CreateAgentGrantInput extends ValidatedGrantInput {
  team_id: string;
  agent_id: string;
  now?: number;
}

/** Persist a new grant. Returns the stored row. */
export async function createAgentGrant(
  adapter: DbAdapter,
  input: CreateAgentGrantInput,
): Promise<AgentGrant> {
  const grant: AgentGrant = {
    id: `grant_${crypto.randomUUID()}`,
    team_id: input.team_id,
    agent_id: input.agent_id,
    grantor_actor_ref: input.grantor_actor_ref,
    grantee_actor_ref: input.grantee_actor_ref,
    grant_kind: input.grant_kind,
    created_at: input.now ?? Date.now(),
    revoked_at: null,
  };
  await adapter.query(
    `INSERT INTO agent_grant
       (id, team_id, agent_id, grantor_actor_ref, grantee_actor_ref, grant_kind, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
    [
      grant.id,
      grant.team_id,
      grant.agent_id,
      grant.grantor_actor_ref,
      grant.grantee_actor_ref,
      grant.grant_kind,
      grant.created_at,
    ],
  );
  return grant;
}

/** List grants for one agent. Active-only by default. */
export async function listAgentGrants(
  adapter: DbAdapter,
  opts: { team_id: string; agent_id: string; includeRevoked?: boolean },
): Promise<AgentGrant[]> {
  const where = ["team_id = $1", "agent_id = $2"];
  if (!opts.includeRevoked) where.push("revoked_at IS NULL");
  const { rows } = await adapter.query<AgentGrantRow>(
    `SELECT * FROM agent_grant WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
    [opts.team_id, opts.agent_id],
  );
  return rows.map(rowToGrant);
}

/** List active grants where the given actor is the grantee (their shared inbox). */
export async function listGrantsForGrantee(
  adapter: DbAdapter,
  opts: { team_id: string; grantee_actor_ref: string },
): Promise<AgentGrant[]> {
  const { rows } = await adapter.query<AgentGrantRow>(
    `SELECT * FROM agent_grant
       WHERE team_id = $1 AND grantee_actor_ref = $2 AND revoked_at IS NULL
       ORDER BY created_at ASC`,
    [opts.team_id, opts.grantee_actor_ref],
  );
  return rows.map(rowToGrant);
}

export async function getAgentGrant(
  adapter: DbAdapter,
  opts: { team_id: string; id: string },
): Promise<AgentGrant | null> {
  const { rows } = await adapter.query<AgentGrantRow>(
    `SELECT * FROM agent_grant WHERE team_id = $1 AND id = $2`,
    [opts.team_id, opts.id],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

/** Revoke a grant (idempotent: a no-op if already revoked). Returns the row. */
export async function revokeAgentGrant(
  adapter: DbAdapter,
  opts: { team_id: string; id: string; now?: number },
): Promise<AgentGrant | null> {
  const now = opts.now ?? Date.now();
  await adapter.query(
    `UPDATE agent_grant SET revoked_at = $1 WHERE team_id = $2 AND id = $3 AND revoked_at IS NULL`,
    [now, opts.team_id, opts.id],
  );
  return getAgentGrant(adapter, { team_id: opts.team_id, id: opts.id });
}
