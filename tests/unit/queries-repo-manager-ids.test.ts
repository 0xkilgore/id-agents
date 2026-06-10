// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  const teams = new SqliteTeamsRepo(adapter);
  const agents = new SqliteAgentsRepo(adapter);
  const teamId = await teams.getOrCreateTeamId("test-team");
  const agentId = "agent_1";
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
  return {
    adapter,
    queries: new SqliteQueriesRepo(adapter),
    teamId,
    agentId,
  };
}

describe("QueriesRepository — manager_dispatch_id / manager_query_id", () => {
  it("upsert + getByQueryIdForTeam roundtrips manager ids", async () => {
    const { queries, teamId, agentId } = await setup();
    await queries.upsert(teamId, agentId, {
      query_id: "q-1",
      status: "pending",
      manager_dispatch_id: "phid:disp-abc",
      manager_query_id: "query_upstream_1",
    });
    const row = await queries.getByQueryIdForTeam(teamId, "q-1");
    expect(row?.manager_dispatch_id).toBe("phid:disp-abc");
    expect(row?.manager_query_id).toBe("query_upstream_1");
  });

  it("rows pre-dating the migration return null for both new columns", async () => {
    const { adapter, queries, teamId, agentId } = await setup();
    await adapter.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [teamId, agentId, "q-legacy", "pending", "hi", 0, "agent", agentId],
    );
    const row = await queries.getByQueryIdForTeam(teamId, "q-legacy");
    expect(row?.manager_dispatch_id).toBeNull();
    expect(row?.manager_query_id).toBeNull();
  });

  it("partial upsert (no manager_dispatch_id key) does NOT null an existing value (COALESCE)", async () => {
    const { queries, teamId, agentId } = await setup();
    await queries.upsert(teamId, agentId, {
      query_id: "q-2",
      status: "pending",
      manager_dispatch_id: "phid:disp-keep",
      manager_query_id: "query_upstream_keep",
    });
    // Re-upsert without the manager ids — should NOT erase the values.
    await queries.upsert(teamId, agentId, {
      query_id: "q-2",
      status: "processing",
    });
    const row = await queries.getByQueryIdForTeam(teamId, "q-2");
    expect(row?.status).toBe("processing");
    expect(row?.manager_dispatch_id).toBe("phid:disp-keep");
    expect(row?.manager_query_id).toBe("query_upstream_keep");
  });
});
