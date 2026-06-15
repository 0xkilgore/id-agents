// W2-1 DispatchVerificationStorage — durable projection persistence.
//
// TDD coverage for migrate / upsertMany / readWindow / readAgentWindow /
// readLastVerifiedByAgent against an in-memory SQLite adapter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { DispatchVerificationStorage } from "../../src/dispatch-verification/storage.js";
import type { DispatchVerification } from "../../src/dispatch-verification/types.js";

let adapter: SqliteAdapter;
let storage: DispatchVerificationStorage;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  storage = new DispatchVerificationStorage(adapter);
  await storage.migrate();
});

afterEach(async () => {
  await adapter.close();
});

function makeVerification(
  overrides: Partial<DispatchVerification> = {},
): DispatchVerification {
  return {
    schema_version: "dispatch-verification.v1",
    team_id: "team-test",
    dispatch_id: "phid:disp-1",
    query_id: "query-1",
    agent_name: "coder-max",
    status: "verified",
    verified: true,
    failure_type: null,
    failure_detail: null,
    artifact_path: "/abs/output/report.md",
    artifact_exists: true,
    artifact_mtime: "2026-06-15T12:00:00.000Z",
    delivery_window_start: "2026-06-15T11:55:00.000Z",
    delivery_window_end: "2026-06-15T12:05:00.000Z",
    promotion_required: false,
    promotion_verified: null,
    promotion_failure_detail: null,
    dispatch_status: "done",
    dispatch_created_at: "2026-06-15T11:50:00.000Z",
    dispatch_started_at: "2026-06-15T11:52:00.000Z",
    dispatch_completed_at: "2026-06-15T12:01:00.000Z",
    result_success: true,
    tl_dr: "did the thing",
    kind: "report",
    checked_at: "2026-06-15T12:10:00.000Z",
    source_metadata: {
      source: "dispatch_scheduler_queue",
      result_source: "artifact_path",
    },
    ...overrides,
  };
}

describe("DispatchVerificationStorage", () => {
  it("migrate() creates the table and is idempotent", async () => {
    // calling twice must not throw
    await storage.migrate();
    await storage.migrate();
    const res = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_verifications'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it("upsertMany inserts rows; readWindow returns them hydrated", async () => {
    const v = makeVerification();
    await storage.upsertMany([v]);

    const rows = await storage.readWindow(
      "team-test",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
    );
    expect(rows).toHaveLength(1);
    const got = rows[0];
    expect(got).toEqual(v);
    // explicit boolean / null round-trip checks
    expect(got.verified).toBe(true);
    expect(got.artifact_exists).toBe(true);
    expect(got.promotion_verified).toBeNull();
    expect(got.failure_type).toBeNull();
    expect(got.source_metadata).toEqual({
      source: "dispatch_scheduler_queue",
      result_source: "artifact_path",
    });
    expect(got.schema_version).toBe("dispatch-verification.v1");
  });

  it("round-trips false / null boolean fields correctly", async () => {
    const v = makeVerification({
      dispatch_id: "phid:disp-false",
      verified: false,
      status: "unverified",
      artifact_exists: false,
      promotion_required: true,
      promotion_verified: false,
      result_success: false,
      failure_type: "artifact_missing",
      failure_detail: "no file",
      artifact_path: null,
    });
    await storage.upsertMany([v]);
    const rows = await storage.readWindow(
      "team-test",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(v);
    expect(rows[0].verified).toBe(false);
    expect(rows[0].artifact_exists).toBe(false);
    expect(rows[0].promotion_verified).toBe(false);
    expect(rows[0].result_success).toBe(false);
    expect(rows[0].artifact_path).toBeNull();
  });

  it("upsertMany is idempotent by PK and updates in place", async () => {
    const v1 = makeVerification({ tl_dr: "first", verified: false, status: "unverified" });
    await storage.upsertMany([v1]);
    const v2 = makeVerification({ tl_dr: "second", verified: true, status: "verified" });
    await storage.upsertMany([v2]);

    const rows = await storage.readWindow(
      "team-test",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tl_dr).toBe("second");
    expect(rows[0].verified).toBe(true);
    expect(rows[0].status).toBe("verified");
  });

  it("readWindow orders by dispatch_completed_at DESC and excludes NULL completed_at", async () => {
    const early = makeVerification({
      dispatch_id: "phid:early",
      dispatch_completed_at: "2026-06-15T08:00:00.000Z",
    });
    const late = makeVerification({
      dispatch_id: "phid:late",
      dispatch_completed_at: "2026-06-15T20:00:00.000Z",
    });
    const incomplete = makeVerification({
      dispatch_id: "phid:incomplete",
      dispatch_completed_at: null,
    });
    await storage.upsertMany([early, late, incomplete]);

    const rows = await storage.readWindow(
      "team-test",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
    );
    expect(rows.map((r) => r.dispatch_id)).toEqual(["phid:late", "phid:early"]);
  });

  it("readWindow excludes a row completed before `from`", async () => {
    const before = makeVerification({
      dispatch_id: "phid:before",
      dispatch_completed_at: "2026-06-14T23:59:59.000Z",
    });
    const inside = makeVerification({
      dispatch_id: "phid:inside",
      dispatch_completed_at: "2026-06-15T12:00:00.000Z",
    });
    await storage.upsertMany([before, inside]);

    const rows = await storage.readWindow(
      "team-test",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
    );
    expect(rows.map((r) => r.dispatch_id)).toEqual(["phid:inside"]);
  });

  it("readAgentWindow filters by agent and respects limit + window", async () => {
    const a1 = makeVerification({
      dispatch_id: "phid:a1",
      agent_name: "agent-a",
      dispatch_completed_at: "2026-06-15T10:00:00.000Z",
    });
    const a2 = makeVerification({
      dispatch_id: "phid:a2",
      agent_name: "agent-a",
      dispatch_completed_at: "2026-06-15T11:00:00.000Z",
    });
    const a3 = makeVerification({
      dispatch_id: "phid:a3",
      agent_name: "agent-a",
      dispatch_completed_at: "2026-06-15T12:00:00.000Z",
    });
    const b1 = makeVerification({
      dispatch_id: "phid:b1",
      agent_name: "agent-b",
      dispatch_completed_at: "2026-06-15T12:30:00.000Z",
    });
    await storage.upsertMany([a1, a2, a3, b1]);

    const rows = await storage.readAgentWindow(
      "team-test",
      "agent-a",
      "2026-06-15T00:00:00.000Z",
      "2026-06-16T00:00:00.000Z",
      2,
    );
    expect(rows.every((r) => r.agent_name === "agent-a")).toBe(true);
    // most recent first, limited to 2
    expect(rows.map((r) => r.dispatch_id)).toEqual(["phid:a3", "phid:a2"]);
  });

  it("readLastVerifiedByAgent returns latest verified row with artifact_path", async () => {
    const unverified = makeVerification({
      dispatch_id: "phid:u",
      agent_name: "agent-a",
      verified: false,
      status: "unverified",
      dispatch_completed_at: "2026-06-15T13:00:00.000Z",
    });
    const verifiedNoArtifact = makeVerification({
      dispatch_id: "phid:vna",
      agent_name: "agent-a",
      verified: true,
      artifact_path: null,
      dispatch_completed_at: "2026-06-15T12:30:00.000Z",
    });
    const verifiedOld = makeVerification({
      dispatch_id: "phid:vold",
      agent_name: "agent-a",
      verified: true,
      artifact_path: "/abs/old.md",
      dispatch_completed_at: "2026-06-15T10:00:00.000Z",
    });
    const verifiedNew = makeVerification({
      dispatch_id: "phid:vnew",
      agent_name: "agent-a",
      verified: true,
      artifact_path: "/abs/new.md",
      dispatch_completed_at: "2026-06-15T11:00:00.000Z",
    });
    await storage.upsertMany([unverified, verifiedNoArtifact, verifiedOld, verifiedNew]);

    const got = await storage.readLastVerifiedByAgent("team-test", "agent-a");
    expect(got).not.toBeNull();
    expect(got?.dispatch_id).toBe("phid:vnew");
    expect(got?.artifact_path).toBe("/abs/new.md");
  });

  it("readLastVerifiedByAgent returns null when no qualifying row exists", async () => {
    const unverified = makeVerification({
      dispatch_id: "phid:none",
      agent_name: "agent-z",
      verified: false,
      status: "unverified",
    });
    await storage.upsertMany([unverified]);
    const got = await storage.readLastVerifiedByAgent("team-test", "agent-z");
    expect(got).toBeNull();
  });
});
