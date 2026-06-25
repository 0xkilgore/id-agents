// T-CKPT.agent-sharing / F4 — grant persistence against a real in-memory DB:
// insert/idempotency/scope-raise, filtered listing, and revoke round-trip.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  migrateAgentSharingTables,
  insertGrant,
  listGrants,
  getGrant,
  revokeGrant,
} from "../../src/agent-sharing/storage.js";
import { buildGrant, type BuildGrantInput } from "../../src/agent-sharing/model.js";

let adapter: SqliteAdapter;
const NOW = "2026-06-24T12:00:00.000Z";
let counter = 0;
const idGen = () => `grant-${++counter}`;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateAgentSharingTables(adapter);
  counter = 0;
});

function grantOf(over: Partial<BuildGrantInput>, now = NOW) {
  const r = buildGrant(
    { kind: "share", actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz", ...over },
    now,
    idGen,
  );
  if (!r.ok) throw new Error(`buildGrant failed: ${r.error}`);
  return r.grant;
}

describe("agent-sharing storage", () => {
  it("persists a share and reads it back", async () => {
    const { grant, created } = await insertGrant(adapter, grantOf({}));
    expect(created).toBe(true);
    const fetched = await getGrant(adapter, grant.grant_id);
    expect(fetched).toMatchObject({ kind: "share", actor_ref: "user:chris", grantee_ref: "user:liz" });
  });

  it("is idempotent — re-sharing the same tuple returns the existing active grant", async () => {
    const first = await insertGrant(adapter, grantOf({}));
    const second = await insertGrant(adapter, grantOf({}));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant.grant_id).toBe(first.grant.grant_id);
    expect(await listGrants(adapter, {})).toHaveLength(1);
  });

  it("raises scope (view → collaborate) on a re-share instead of duplicating", async () => {
    const a = await insertGrant(adapter, grantOf({ scope: "view" }));
    expect(a.grant.scope).toBe("view");
    const b = await insertGrant(adapter, grantOf({ scope: "collaborate" }));
    expect(b.created).toBe(false);
    expect(b.grant.scope).toBe("collaborate");
    expect((await getGrant(adapter, a.grant.grant_id))?.scope).toBe("collaborate");
  });

  it("persists a delegate to an agent and filters by kind + grantee", async () => {
    await insertGrant(adapter, grantOf({}));
    await insertGrant(adapter, grantOf({ kind: "delegate", grantee_ref: "finances", subject_ref: "q2" }));

    const delegations = await listGrants(adapter, { kind: "delegate" });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ grantee_kind: "agent", grantee_ref: "finances" });

    const toFinances = await listGrants(adapter, { grantee_kind: "agent", grantee_ref: "finances" });
    expect(toFinances).toHaveLength(1);
  });

  it("filters by subject", async () => {
    await insertGrant(adapter, grantOf({ subject_ref: "blowout" }));
    await insertGrant(adapter, grantOf({ subject_ref: "finances", grantee_ref: "user:liz" }));
    const onBlowout = await listGrants(adapter, { subject_kind: "project", subject_ref: "blowout" });
    expect(onBlowout).toHaveLength(1);
    expect(onBlowout[0].subject_ref).toBe("blowout");
  });

  it("revokes a grant; it drops out of the active list and frees the identity", async () => {
    const { grant } = await insertGrant(adapter, grantOf({}));
    const rev = await revokeGrant(adapter, grant.grant_id, "user:chris", "2026-06-24T13:00:00.000Z");
    expect(rev.ok).toBe(true);
    expect(rev.grant?.revoked_by).toBe("user:chris");

    expect(await listGrants(adapter, {})).toHaveLength(0); // active-only default
    expect(await listGrants(adapter, { active_only: false })).toHaveLength(1);

    // identity is freed: the same tuple can be re-granted as a fresh active row.
    const re = await insertGrant(adapter, grantOf({}));
    expect(re.created).toBe(true);
    expect(re.grant.grant_id).not.toBe(grant.grant_id);
  });

  it("revoke is idempotency-safe (already_revoked on a second revoke)", async () => {
    const { grant } = await insertGrant(adapter, grantOf({}));
    await revokeGrant(adapter, grant.grant_id, "user:chris", NOW);
    const again = await revokeGrant(adapter, grant.grant_id, "user:chris", NOW);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("already_revoked");
  });

  it("revoking a missing grant reports not_found", async () => {
    const r = await revokeGrant(adapter, "nope", "user:chris", NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_found");
  });
});
