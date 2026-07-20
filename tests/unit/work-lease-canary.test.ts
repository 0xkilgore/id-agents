import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { WorkLeaseConflict, WorkLeaseStore, shouldEnforceWorkLease, workLeaseCanaryPolicy } from "../../src/work-leases/canary.js";

describe("WorkLease canary", () => {
  it("allows one owner, renews, releases, then advances the fence", () => {
    const store = new WorkLeaseStore(new Database(":memory:"));
    const first = store.acquire({ resource: "coding:canary", dispatch_id: "d1", owner_id: "m1", ttl_ms: 50, now_ms: 100 });
    expect(() => store.acquire({ resource: "coding:canary", dispatch_id: "d2", owner_id: "m2", ttl_ms: 50, now_ms: 101 }))
      .toThrowError(WorkLeaseConflict);
    expect(store.renew(first.lease_id, first.fencing_token, 100, 120).expires_at_ms).toBe(220);
    store.release(first.lease_id, first.fencing_token, 130);
    const second = store.acquire({ resource: "coding:canary", dispatch_id: "d2", owner_id: "m2", ttl_ms: 50, now_ms: 131 });
    expect(second.fencing_token).toBe(first.fencing_token + 1);
  });

  it("expires elapsed ownership and rejects the stale fence after takeover", () => {
    const store = new WorkLeaseStore(new Database(":memory:"));
    const stale = store.acquire({ resource: "coding:canary", dispatch_id: "d1", owner_id: "m1", ttl_ms: 10, now_ms: 100 });
    const replacement = store.acquire({ resource: "coding:canary", dispatch_id: "d2", owner_id: "m2", ttl_ms: 10, now_ms: 111 });
    expect(store.byId(stale.lease_id)?.state).toBe("expired");
    expect(() => store.assertFence("coding:canary", stale.lease_id, stale.fencing_token, 112))
      .toThrowError(/stale/);
    expect(store.assertFence("coding:canary", replacement.lease_id, replacement.fencing_token, 112).owner_id).toBe("m2");
  });

  it("recovers live leases after restart and expires abandoned leases", () => {
    const db = new Database(":memory:");
    const before = new WorkLeaseStore(db);
    before.acquire({ resource: "coding:canary", dispatch_id: "d1", owner_id: "m1", ttl_ms: 20, now_ms: 100 });
    before.acquire({ resource: "coding:other", dispatch_id: "d2", owner_id: "m1", ttl_ms: 5, now_ms: 100 });
    const after = new WorkLeaseStore(db);
    expect(after.recover(110).map((lease) => lease.resource)).toEqual(["coding:canary"]);
    expect(after.current("coding:other")).toBeNull();
  });

  it("rolls authority back to legacy without affecting shadow observations", () => {
    expect(workLeaseCanaryPolicy({})).toEqual({ authority: "off", lane: null });
    const shadow = workLeaseCanaryPolicy({ IDAGENTS_WORKLEASE_AUTHORITY: "shadow", IDAGENTS_WORKLEASE_CANARY_LANE: "coding:canary" });
    expect(shouldEnforceWorkLease(shadow, "coding:canary")).toBe(false);
    const canary = { ...shadow, authority: "canary" as const };
    expect(shouldEnforceWorkLease(canary, "coding:canary")).toBe(true);
    expect(shouldEnforceWorkLease(canary, "coding:other")).toBe(false);
  });
});
