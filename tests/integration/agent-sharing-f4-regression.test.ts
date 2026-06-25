// T-QA.5 / BACKFILL — reproducing regression test for F4 agent-sharing (b5424c6).
//
// Pins the canonical F4 scenario end-to-end against a real in-memory DB:
//   - "share blowout → Liz"      : user:chris shares project:blowout with user:liz
//   - "delegate to finances"     : user:chris delegates project:blowout to agent:finances
// and asserts BOTH grants PERSIST with correct ACTOR_REF SCOPING — i.e. each grant
// is stored under the GRANTING Monday actor (user:chris), is retrievable by that
// actor_ref, and is isolated from a different actor's view. A regression in the
// persistence path or the actor_ref scoping (the F4 contract) fails this test.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  migrateAgentSharingTables,
  insertGrant,
  listGrants,
} from "../../src/agent-sharing/storage.js";
import { buildGrant, type BuildGrantInput } from "../../src/agent-sharing/model.js";

let adapter: SqliteAdapter;
const NOW = "2026-06-25T12:00:00.000Z";
let counter = 0;
const idGen = () => `grant-${++counter}`;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateAgentSharingTables(adapter);
  counter = 0;
});

function build(over: Partial<BuildGrantInput>) {
  const r = buildGrant(
    { kind: "share", actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout", grantee_ref: "user:liz", ...over },
    NOW,
    idGen,
  );
  if (!r.ok) throw new Error(`buildGrant failed: ${r.error}`);
  return r.grant;
}

describe("F4 agent-sharing regression — share blowout→Liz + delegate→finances persist with actor_ref scoping", () => {
  it("persists both the share and the delegate, scoped to the granting actor", async () => {
    const share = await insertGrant(adapter, build({})); // chris shares blowout → liz
    const delegate = await insertGrant(
      adapter,
      build({ kind: "delegate", grantee_ref: "finances" }), // chris delegates blowout → agent:finances
    );
    expect(share.created).toBe(true);
    expect(delegate.created).toBe(true);

    // Both persisted under the granting Monday actor (actor_ref scoping).
    const chrisGrants = await listGrants(adapter, { actor_ref: "user:chris" });
    expect(chrisGrants).toHaveLength(2);

    const shareRow = chrisGrants.find((g) => g.kind === "share");
    const delegateRow = chrisGrants.find((g) => g.kind === "delegate");
    expect(shareRow).toMatchObject({
      actor_ref: "user:chris",
      subject_kind: "project",
      subject_ref: "blowout",
      grantee_kind: "user",
      grantee_ref: "user:liz",
    });
    expect(delegateRow).toMatchObject({
      actor_ref: "user:chris",
      subject_ref: "blowout",
      grantee_kind: "agent",
      grantee_ref: "finances",
    });
  });

  it("scopes grants to the granting actor — a different actor's view does not see them", async () => {
    await insertGrant(adapter, build({})); // granted BY user:chris
    await insertGrant(adapter, build({ kind: "delegate", grantee_ref: "finances" }));

    // user:liz is the share GRANTEE, not the grantor — actor_ref scoping must not
    // surface chris's grants under liz's actor_ref.
    expect(await listGrants(adapter, { actor_ref: "user:liz" })).toHaveLength(0);
    // The grantor sees both.
    expect(await listGrants(adapter, { actor_ref: "user:chris" })).toHaveLength(2);
  });

  it("keeps share and delegate as distinct active grants on the same subject (no collision)", async () => {
    // share and delegate of the SAME subject differ in identity (kind + grantee),
    // so both stay active — the F4 'share AND delegate the same thing' case.
    await insertGrant(adapter, build({}));
    await insertGrant(adapter, build({ kind: "delegate", grantee_ref: "finances" }));

    const onBlowout = await listGrants(adapter, { actor_ref: "user:chris", subject_kind: "project", subject_ref: "blowout" });
    expect(onBlowout).toHaveLength(2);
    expect(new Set(onBlowout.map((g) => g.kind))).toEqual(new Set(["share", "delegate"]));
  });
});
