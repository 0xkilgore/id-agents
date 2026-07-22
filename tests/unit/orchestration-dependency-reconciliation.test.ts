import { beforeEach, describe, expect, it } from "vitest";
import {
  getBacklogItem,
  insertBacklogItem,
  listRecentDecisions,
  reconcileTerminalBacklogDependencies,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
});

async function upstream(logicalKey: string, state: "done" | "superseded" | "failed" | "needs_review") {
  const row = await insertBacklogItem(adapter, {
    title: logicalKey,
    logical_key: logicalKey,
    readiness_state: state === "needs_review" ? "needs_review" : "ready",
  });
  if (state !== "needs_review") await setItemState(adapter, row.item_id, state);
  return row;
}

async function blocked(title: string, dependencies: string[]) {
  return insertBacklogItem(adapter, { title, readiness_state: "blocked_dependency", dependencies });
}

describe("reconcileTerminalBacklogDependencies", () => {
  it.each(["done", "superseded"] as const)("makes a logical-key dependency in %s admissible", async (state) => {
    await upstream(`dep:${state}`, state);
    const row = await blocked(`downstream ${state}`, [`dep:${state}`]);

    const result = await reconcileTerminalBacklogDependencies(adapter, { limit: 10, tick_id: "tick:test" });

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({ item_id: row.item_id, to_state: "ready", resolved: [{ dependency: `dep:${state}`, dependency_state: state }] });
    expect(await getBacklogItem(adapter, row.item_id)).toMatchObject({ readiness_state: "ready", dependencies: [] });
    expect((await listRecentDecisions(adapter, { limit: 1 }))[0]).toMatchObject({
      item_id: row.item_id,
      action: "reconciled",
      reason: expect.stringContaining(`dep:${state}=${state}`),
      metadata: { operation: "reconcile_terminal_backlog_dependencies", to_state: "ready", resolved: [{ dependency: `dep:${state}`, dependency_state: state }] },
    });
  });

  it.each(["failed", "needs_review"] as const)("does not satisfy a %s dependency", async (state) => {
    await upstream(`dep:${state}`, state);
    const row = await blocked(`downstream ${state}`, [`dep:${state}`]);

    const result = await reconcileTerminalBacklogDependencies(adapter, { limit: 10 });

    expect(result.transitions).toEqual([]);
    expect(await getBacklogItem(adapter, row.item_id)).toMatchObject({ readiness_state: "blocked_dependency", dependencies: [`dep:${state}`] });
  });

  it("fails closed for a missing logical key", async () => {
    const row = await blocked("missing", ["dep:missing"]);
    expect((await reconcileTerminalBacklogDependencies(adapter, { limit: 10 })).transitions).toEqual([]);
    expect(await getBacklogItem(adapter, row.item_id)).toMatchObject({ readiness_state: "blocked_dependency", dependencies: ["dep:missing"] });
  });

  it("leaves a dependency cycle blocked", async () => {
    const a = await blocked("cycle a", ["cycle:b"]);
    const b = await blocked("cycle b", ["cycle:a"]);
    await adapter.query("UPDATE orchestration_backlog_item SET logical_key = $1 WHERE item_id = $2", ["cycle:a", a.item_id]);
    await adapter.query("UPDATE orchestration_backlog_item SET logical_key = $1 WHERE item_id = $2", ["cycle:b", b.item_id]);

    const result = await reconcileTerminalBacklogDependencies(adapter, { limit: 10 });

    expect(result.transitions).toEqual([]);
    expect((await getBacklogItem(adapter, a.item_id))?.readiness_state).toBe("blocked_dependency");
    expect((await getBacklogItem(adapter, b.item_id))?.readiness_state).toBe("blocked_dependency");
  });

  it("is bounded and keeps unresolved dependencies while auditing the partial transition", async () => {
    await upstream("dep:done", "done");
    const first = await blocked("first", ["dep:done", "dep:missing"]);
    await blocked("second", ["dep:done"]);
    await adapter.query("UPDATE orchestration_backlog_item SET priority = 0 WHERE item_id = $1", [first.item_id]);

    const result = await reconcileTerminalBacklogDependencies(adapter, { limit: 1 });

    expect(result).toMatchObject({ scanned: 1, cap: 1, truncated: true });
    expect(await getBacklogItem(adapter, first.item_id)).toMatchObject({ readiness_state: "blocked_dependency", dependencies: ["dep:missing"] });
    expect(result.transitions[0]).toMatchObject({ to_state: "blocked_dependency", dependencies_after: ["dep:missing"] });
  });
});
