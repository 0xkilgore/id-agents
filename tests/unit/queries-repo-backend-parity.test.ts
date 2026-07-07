// SPDX-License-Identifier: MIT
//
// RD-009/RD-010: doc-model search and the queries-repo read path used to
// behave differently depending on backend dialect:
//   - search.ts used to return either a masked empty result or HTTP 501 for
//     non-sqlite adapters. Postgres now has a native search path (RD-009).
//   - SqliteQueriesRepo.getPending() had no ORDER BY (undefined order),
//     while PgQueriesRepo.getPending() ordered by created ASC (RD-010a).
//   - owner_kind/owner_id backfill + `result` null-vs-{} coercion only
//     happened in SqliteQueriesRepo.parseQueryRow; PgQueriesRepo returned
//     raw rows with no equivalent normalization (RD-010b).
//
// RD-010 is now fixed by construction: both repos call the same
// normalizeQueryRow()/resolveQueryOwnership() functions, so the "same
// query battery against both backends" battery below is run once against
// the shared function — there is only one implementation left to drift.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import {
  normalizeQueryRow,
  resolveQueryOwnership,
} from "../../src/db/repos/query-row-normalize.js";
import { searchDocModel } from "../../src/doc-model/search.js";
import type { DbAdapter } from "../../src/db/db-adapter.js";

describe("normalizeQueryRow — same row battery, same output regardless of backend", () => {
  const battery: Array<{ name: string; row: any; expect: Partial<Record<string, unknown>> }> = [
    {
      name: "well-formed agent-owned row (owner_kind/owner_id already correct)",
      row: {
        team_id: "team-1",
        agent_id: "agent_a",
        owner_kind: "agent",
        owner_id: "agent_a",
        result: { ok: true },
      },
      expect: { owner_kind: "agent", owner_id: "agent_a", result: { ok: true } },
    },
    {
      name: "well-formed manager-owned row",
      row: {
        team_id: "team-1",
        agent_id: "manager-team-1",
        owner_kind: "manager",
        owner_id: "team-1",
        result: null,
      },
      expect: { owner_kind: "manager", owner_id: "team-1", result: null },
    },
    {
      name: "legacy row: owner_kind missing/invalid, agent_id manager-prefixed — must derive manager ownership",
      row: { team_id: "team-1", agent_id: "manager-team-1", owner_kind: null, owner_id: "" },
      expect: { owner_kind: "manager", owner_id: "team-1" },
    },
    {
      name: "legacy row: owner_kind missing/invalid, plain agent_id — must derive agent ownership",
      row: { team_id: "team-1", agent_id: "agent_b", owner_kind: null, owner_id: "" },
      expect: { owner_kind: "agent", owner_id: "agent_b" },
    },
    {
      name: "owner_kind already a valid enum value is trusted as-is even if owner_id looks stale",
      row: { team_id: "team-1", agent_id: "manager-team-1", owner_kind: "agent", owner_id: "" },
      expect: { owner_kind: "agent", owner_id: "manager-team-1" },
    },
    {
      name: "manager-owned row with no agent_id (owner columns already set) — must not require agent_id",
      row: { team_id: "team-1", agent_id: null, owner_kind: "manager", owner_id: "team-1" },
      expect: { owner_kind: "manager", owner_id: "team-1", agent_id: null },
    },
    {
      name: "result stored as JSON text (SQLite shape) is parsed to an object",
      row: { team_id: "team-1", agent_id: "agent_a", owner_kind: "agent", owner_id: "agent_a", result: '{"a":1}' },
      expect: { result: { a: 1 } },
    },
    {
      name: "result already a parsed object (Postgres jsonb shape) passes through unchanged",
      row: { team_id: "team-1", agent_id: "agent_a", owner_kind: "agent", owner_id: "agent_a", result: { a: 1 } },
      expect: { result: { a: 1 } },
    },
    {
      name: "null result stays null (not coerced to {})",
      row: { team_id: "team-1", agent_id: "agent_a", owner_kind: "agent", owner_id: "agent_a", result: null },
      expect: { result: null },
    },
    {
      name: "empty-string agent_id normalizes to null",
      row: { team_id: "team-1", agent_id: "", owner_kind: "manager", owner_id: "team-1" },
      expect: { agent_id: null },
    },
  ];

  for (const { name, row, expect: expected } of battery) {
    it(name, () => {
      const normalized = normalizeQueryRow(row);
      expect(normalized).not.toBeNull();
      for (const [key, value] of Object.entries(expected)) {
        expect((normalized as any)[key]).toEqual(value);
      }
    });
  }

  it("returns null for a null row", () => {
    expect(normalizeQueryRow(null)).toBeNull();
  });
});

describe("resolveQueryOwnership — shared by both backends' create()/upsert()", () => {
  it("derives manager ownership from a manager-prefixed agent id", () => {
    expect(resolveQueryOwnership("team-1", "manager-team-1")).toEqual({
      owner_kind: "manager",
      owner_id: "team-1",
    });
  });

  it("derives agent ownership from a plain agent id", () => {
    expect(resolveQueryOwnership("team-1", "agent_a")).toEqual({
      owner_kind: "agent",
      owner_id: "agent_a",
    });
  });

  it("honors an explicit override even when agentId is null", () => {
    expect(
      resolveQueryOwnership("team-1", null, { owner_kind: "manager", owner_id: "team-1" }),
    ).toEqual({ owner_kind: "manager", owner_id: "team-1" });
  });

  it("throws when agentId is null and no override is given", () => {
    expect(() => resolveQueryOwnership("team-1", null)).toThrow(
      /ownership override required/,
    );
  });
});

describe("SqliteQueriesRepo.getPending — RD-010a ordering parity", () => {
  async function setup() {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId("test-team");
    const agentId = "agent_order";
    await agents.upsert({
      team_id: teamId,
      id: agentId,
      name: "agent",
      type: "claude",
      model: "test",
      port: 0,
      endpoint: "http://localhost:0",
      working_directory: null,
      status: "running",
      created_at: Date.now(),
      metadata: {},
    });
    return { queries: new SqliteQueriesRepo(adapter), teamId, agentId };
  }

  it("returns pending rows oldest-created-first, matching PgQueriesRepo.getPending's ORDER BY created ASC", async () => {
    const { queries, teamId, agentId } = await setup();
    // Insert out of created-time order to prove there's an explicit ORDER BY
    // rather than relying on insertion/rowid order.
    await queries.create(teamId, "q-newest", agentId, "third", 3000);
    await queries.create(teamId, "q-oldest", agentId, "first", 1000);
    await queries.create(teamId, "q-middle", agentId, "second", 2000);

    const pending = await queries.getPending(agentId);
    expect(pending.map((row) => row.query_id)).toEqual(["q-oldest", "q-middle", "q-newest"]);
  });
});

describe("searchDocModel — RD-009 Postgres dialect support", () => {
  it("uses the normal search envelope for Postgres instead of throwing HTTP 501", async () => {
    const fakeAdapter: DbAdapter = {
      dialect: "postgres",
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => {},
    };

    await expect(searchDocModel(fakeAdapter, "anything")).resolves.toEqual({
      items: [],
      limit: 50,
      offset: 0,
    });
  });
});
