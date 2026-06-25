// SPDX-License-Identifier: MIT
// T-CKPT.agent-sharing/F4 — agent sharing/delegation grants.
//   - pure policy: normalizeGrantKind / validateGrantInput / view+delegate /
//     visibleGrantsFor / canRevokeGrant
//   - persistence (in-memory sqlite): create / list / list-by-grantee / revoke
// Backed by SQLite in-memory; the postgres adapter shares the same SQL shape.

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  normalizeGrantKind,
  validateGrantInput,
  actorCanView,
  actorCanDelegate,
  visibleGrantsFor,
  canRevokeGrant,
  createAgentGrant,
  listAgentGrants,
  listGrantsForGrantee,
  revokeAgentGrant,
  getAgentGrant,
  type AgentGrant,
} from "../../src/agent-sharing/grants.js";

const TEAM = "team_default";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [TEAM, "default"]);
  return adapter;
}

async function insertAgent(adapter: SqliteAdapter, name: string): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [TEAM, id, name, "persistent", "claude-opus", 24000, "active", Date.now(), "claude-code"],
  );
  return id;
}

function grant(over: Partial<AgentGrant> = {}): AgentGrant {
  return {
    id: over.id ?? "grant_x",
    team_id: TEAM,
    agent_id: over.agent_id ?? "agent_x",
    grantor_actor_ref: over.grantor_actor_ref ?? "user:chris",
    grantee_actor_ref: over.grantee_actor_ref ?? "user:liz",
    grant_kind: over.grant_kind ?? "share",
    created_at: over.created_at ?? 1,
    revoked_at: over.revoked_at ?? null,
  };
}

describe("grants — pure policy", () => {
  it("normalizeGrantKind accepts share/delegate (case-insensitive), rejects others", () => {
    expect(normalizeGrantKind("share")).toBe("share");
    expect(normalizeGrantKind("DELEGATE")).toBe("delegate");
    expect(normalizeGrantKind("admin")).toBeNull();
    expect(normalizeGrantKind(7)).toBeNull();
  });

  it("validateGrantInput normalizes a valid grant", () => {
    const r = validateGrantInput({ grantor: "chris", grantee: "user:liz", grant_kind: "delegate" });
    expect(r).toEqual({ ok: true, value: { grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz", grant_kind: "delegate" } });
  });

  it("validateGrantInput rejects unknown actors, bad kind, and self-grants", () => {
    expect(validateGrantInput({ grantor: "mallory", grantee: "user:liz", grant_kind: "share" })).toMatchObject({ ok: false, error: { code: "invalid_actor", field: "grantor" } });
    expect(validateGrantInput({ grantor: "user:chris", grantee: "nobody", grant_kind: "share" })).toMatchObject({ ok: false, error: { code: "invalid_actor", field: "grantee" } });
    expect(validateGrantInput({ grantor: "user:chris", grantee: "user:liz", grant_kind: "owner" })).toMatchObject({ ok: false, error: { code: "invalid_grant_kind" } });
    expect(validateGrantInput({ grantor: "user:chris", grantee: "chris", grant_kind: "share" })).toMatchObject({ ok: false, error: { code: "self_grant" } });
  });

  it("actorCanView: any active grant (share or delegate); actorCanDelegate: delegate only", () => {
    const shared = [grant({ grantee_actor_ref: "user:liz", grant_kind: "share" })];
    expect(actorCanView(shared, "user:liz")).toBe(true);
    expect(actorCanDelegate(shared, "user:liz")).toBe(false);

    const delegated = [grant({ grantee_actor_ref: "user:liz", grant_kind: "delegate" })];
    expect(actorCanView(delegated, "user:liz")).toBe(true);
    expect(actorCanDelegate(delegated, "user:liz")).toBe(true);

    const revoked = [grant({ grantee_actor_ref: "user:liz", grant_kind: "delegate", revoked_at: 5 })];
    expect(actorCanView(revoked, "user:liz")).toBe(false);
    expect(actorCanDelegate(revoked, "user:liz")).toBe(false);
  });

  it("visibleGrantsFor: chris sees all; others only grantor/grantee rows", () => {
    const grants = [
      grant({ id: "g1", grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz" }),
      grant({ id: "g2", grantor_actor_ref: "user:liz", grantee_actor_ref: "user:chris" }),
    ];
    expect(visibleGrantsFor(grants, "user:chris").map((g) => g.id)).toEqual(["g1", "g2"]);
    // user:liz is grantee of g1 and grantor of g2 → sees both here.
    expect(visibleGrantsFor(grants, "user:liz").map((g) => g.id)).toEqual(["g1", "g2"]);
    // a grant between two others would be hidden from a non-participant:
    const other = [grant({ id: "g3", grantor_actor_ref: "user:chris", grantee_actor_ref: "user:chris" })];
    expect(visibleGrantsFor(other, "user:liz")).toEqual([]);
  });

  it("canRevokeGrant: grantor or user:chris only", () => {
    const g = grant({ grantor_actor_ref: "user:liz", grantee_actor_ref: "user:chris" });
    expect(canRevokeGrant(g, "user:liz")).toBe(true); // grantor
    expect(canRevokeGrant(g, "user:chris")).toBe(true); // admin
    const g2 = grant({ grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz" });
    expect(canRevokeGrant(g2, "user:liz")).toBe(false); // grantee can't revoke
  });
});

describe("grants — persistence", () => {
  let adapter: SqliteAdapter;
  let agentId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    agentId = await insertAgent(adapter, "blowout");
  });

  it("creates and lists active grants for an agent", async () => {
    const created = await createAgentGrant(adapter, {
      team_id: TEAM,
      agent_id: agentId,
      grantor_actor_ref: "user:chris",
      grantee_actor_ref: "user:liz",
      grant_kind: "share",
      now: 100,
    });
    expect(created.id).toMatch(/^grant_/);
    expect(created.revoked_at).toBeNull();

    const list = await listAgentGrants(adapter, { team_id: TEAM, agent_id: agentId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ grantee_actor_ref: "user:liz", grant_kind: "share", created_at: 100 });
  });

  it("lists active grants by grantee (shared-with-me)", async () => {
    await createAgentGrant(adapter, { team_id: TEAM, agent_id: agentId, grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz", grant_kind: "delegate", now: 1 });
    const forLiz = await listGrantsForGrantee(adapter, { team_id: TEAM, grantee_actor_ref: "user:liz" });
    expect(forLiz).toHaveLength(1);
    const forChris = await listGrantsForGrantee(adapter, { team_id: TEAM, grantee_actor_ref: "user:chris" });
    expect(forChris).toHaveLength(0);
  });

  it("revoke excludes the grant from active lists but keeps it with includeRevoked", async () => {
    const g = await createAgentGrant(adapter, { team_id: TEAM, agent_id: agentId, grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz", grant_kind: "share", now: 1 });
    const revoked = await revokeAgentGrant(adapter, { team_id: TEAM, id: g.id, now: 200 });
    expect(revoked?.revoked_at).toBe(200);

    expect(await listAgentGrants(adapter, { team_id: TEAM, agent_id: agentId })).toHaveLength(0);
    expect(await listGrantsForGrantee(adapter, { team_id: TEAM, grantee_actor_ref: "user:liz" })).toHaveLength(0);
    expect(await listAgentGrants(adapter, { team_id: TEAM, agent_id: agentId, includeRevoked: true })).toHaveLength(1);
  });

  it("revoke is idempotent (keeps the first revoked_at)", async () => {
    const g = await createAgentGrant(adapter, { team_id: TEAM, agent_id: agentId, grantor_actor_ref: "user:chris", grantee_actor_ref: "user:liz", grant_kind: "share", now: 1 });
    await revokeAgentGrant(adapter, { team_id: TEAM, id: g.id, now: 200 });
    await revokeAgentGrant(adapter, { team_id: TEAM, id: g.id, now: 999 });
    const after = await getAgentGrant(adapter, { team_id: TEAM, id: g.id });
    expect(after?.revoked_at).toBe(200);
  });
});
