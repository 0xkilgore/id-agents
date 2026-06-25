// T-CKPT.agent-sharing / F4 — persistence for share/delegate grants.
//
// One table, agent_grants. A partial UNIQUE index over the identity tuple keeps
// at most ONE active (non-revoked) grant per (kind, actor, subject, grantee), so
// re-sharing the same thing is idempotent rather than piling up duplicate rows.
// All shaping/validation is done by model.buildGrant before we get here.

import type { DbAdapter } from "../db/db-adapter.js";
import type { Grant, GrantKind, GranteeKind } from "./model.js";
import { grantIdentityKey } from "./model.js";

async function execDDL(adapter: DbAdapter, sql: string): Promise<void> {
  const maybeExec = (adapter as unknown as { exec?: (s: string) => void }).exec;
  if (typeof maybeExec === "function") maybeExec.call(adapter, sql);
  else await adapter.query(sql);
}

export async function migrateAgentSharingTables(adapter: DbAdapter): Promise<void> {
  await execDDL(
    adapter,
    `
    CREATE TABLE IF NOT EXISTS agent_grants (
      grant_id      TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      actor_ref     TEXT NOT NULL,
      subject_kind  TEXT NOT NULL,
      subject_ref   TEXT NOT NULL,
      grantee_kind  TEXT NOT NULL,
      grantee_ref   TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT 'collaborate',
      identity_key  TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      revoked_at    TEXT,
      revoked_by    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_active_idx
      ON agent_grants(identity_key) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS agent_grants_subject_idx
      ON agent_grants(subject_kind, subject_ref);
    CREATE INDEX IF NOT EXISTS agent_grants_grantee_idx
      ON agent_grants(grantee_kind, grantee_ref);
  `,
  );
}

interface GrantRow {
  grant_id: string;
  kind: string;
  actor_ref: string;
  subject_kind: string;
  subject_ref: string;
  grantee_kind: string;
  grantee_ref: string;
  scope: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

function rowToGrant(r: GrantRow): Grant {
  return {
    grant_id: r.grant_id,
    kind: r.kind as GrantKind,
    actor_ref: r.actor_ref,
    subject_kind: r.subject_kind,
    subject_ref: r.subject_ref,
    grantee_kind: r.grantee_kind as GranteeKind,
    grantee_ref: r.grantee_ref,
    scope: r.scope as Grant["scope"],
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    revoked_by: r.revoked_by,
  };
}

export interface InsertGrantResult {
  grant: Grant;
  /** false when an identical active grant already existed (idempotent re-share). */
  created: boolean;
}

/**
 * Insert a grant, or return the existing ACTIVE grant with the same identity
 * (idempotent). When an active grant exists but at a lower scope, its scope is
 * raised to the incoming one (view → collaborate) and the existing row returned.
 */
export async function insertGrant(adapter: DbAdapter, grant: Grant): Promise<InsertGrantResult> {
  const identity = grantIdentityKey(grant);
  const existing = await getActiveByIdentity(adapter, identity);
  if (existing) {
    if (existing.scope !== grant.scope && grant.scope === "collaborate") {
      await adapter.query(`UPDATE agent_grants SET scope = $1 WHERE grant_id = $2`, [grant.scope, existing.grant_id]);
      return { grant: { ...existing, scope: grant.scope }, created: false };
    }
    return { grant: existing, created: false };
  }

  await adapter.query(
    `INSERT INTO agent_grants
       (grant_id, kind, actor_ref, subject_kind, subject_ref, grantee_kind, grantee_ref,
        scope, identity_key, created_at, revoked_at, revoked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      grant.grant_id, grant.kind, grant.actor_ref, grant.subject_kind, grant.subject_ref,
      grant.grantee_kind, grant.grantee_ref, grant.scope, identity, grant.created_at, null, null,
    ],
  );
  return { grant, created: true };
}

async function getActiveByIdentity(adapter: DbAdapter, identity: string): Promise<Grant | null> {
  const { rows } = await adapter.query<GrantRow>(
    `SELECT * FROM agent_grants WHERE identity_key = $1 AND revoked_at IS NULL LIMIT 1`,
    [identity],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export async function getGrant(adapter: DbAdapter, grantId: string): Promise<Grant | null> {
  const { rows } = await adapter.query<GrantRow>(`SELECT * FROM agent_grants WHERE grant_id = $1`, [grantId]);
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export interface GrantFilter {
  kind?: GrantKind;
  actor_ref?: string;
  subject_kind?: string;
  subject_ref?: string;
  grantee_kind?: GranteeKind;
  grantee_ref?: string;
  /** Default true — only active (non-revoked) grants. Pass false for all. */
  active_only?: boolean;
}

/** List grants matching a filter, newest first. */
export async function listGrants(adapter: DbAdapter, filter: GrantFilter = {}): Promise<Grant[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, val: unknown) => {
    if (val !== undefined && val !== null && val !== "") {
      params.push(val);
      where.push(`${col} = $${params.length}`);
    }
  };
  eq("kind", filter.kind);
  eq("actor_ref", filter.actor_ref);
  eq("subject_kind", filter.subject_kind);
  eq("subject_ref", filter.subject_ref);
  eq("grantee_kind", filter.grantee_kind);
  eq("grantee_ref", filter.grantee_ref);
  if (filter.active_only !== false) where.push("revoked_at IS NULL");

  const sql =
    `SELECT * FROM agent_grants${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
    `ORDER BY created_at DESC, grant_id DESC`;
  const { rows } = await adapter.query<GrantRow>(sql, params);
  return rows.map(rowToGrant);
}

export interface RevokeResult {
  ok: boolean;
  /** "not_found" | "already_revoked" when ok is false. */
  reason?: "not_found" | "already_revoked";
  grant?: Grant;
}

/** Revoke an active grant (idempotency-safe: a re-revoke reports already_revoked). */
export async function revokeGrant(
  adapter: DbAdapter,
  grantId: string,
  revokedBy: string,
  nowIso: string,
): Promise<RevokeResult> {
  const current = await getGrant(adapter, grantId);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.revoked_at) return { ok: false, reason: "already_revoked", grant: current };
  await adapter.query(`UPDATE agent_grants SET revoked_at = $1, revoked_by = $2 WHERE grant_id = $3`, [
    nowIso,
    revokedBy,
    grantId,
  ]);
  return { ok: true, grant: { ...current, revoked_at: nowIso, revoked_by: revokedBy } };
}
