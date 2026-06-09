// B0 (2026-06-08): production adapter that bridges a QueriesRepository
// into the scheduler's QueryEvidenceClient seam. The adapter is a thin
// wrapper around `getByQueryIdForTeam` plus a null-safe shape-narrow,
// so the test surface is correspondingly narrow.

import { describe, it, expect } from "vitest";
import { QueriesEvidenceClient } from "../../src/dispatch-scheduler/queries-evidence-client.js";
import type { QueriesRepository } from "../../src/db/db-service.js";
import type { QueryRow } from "../../src/db/types.js";

class FakeQueriesRepo implements Partial<QueriesRepository> {
  private rows = new Map<string, QueryRow>();
  calls: Array<{ teamId: string; queryId: string }> = [];

  set(teamId: string, queryId: string, row: Partial<QueryRow>): void {
    this.rows.set(`${teamId}|${queryId}`, {
      team_id: teamId,
      agent_id: "agent-x",
      query_id: queryId,
      status: "processing",
      prompt: "",
      created: 0,
      completed: null,
      result: null,
      error: null,
      session_id: null,
      owner_kind: "agent",
      owner_id: "agent-x",
      last_output_at: null,
      ...row,
    } as QueryRow);
  }

  async getByQueryIdForTeam(teamId: string, queryId: string): Promise<QueryRow | null> {
    this.calls.push({ teamId, queryId });
    return this.rows.get(`${teamId}|${queryId}`) ?? null;
  }
}

describe("QueriesEvidenceClient", () => {
  it("returns null when no query row exists for the team scope", async () => {
    const repo = new FakeQueriesRepo();
    const client = new QueriesEvidenceClient({
      queries: repo as unknown as QueriesRepository,
      teamId: "team-A",
    });
    expect(await client.getEvidence("missing")).toBeNull();
    expect(repo.calls).toEqual([{ teamId: "team-A", queryId: "missing" }]);
  });

  it("projects the row's status and last_output_at into evidence", async () => {
    const repo = new FakeQueriesRepo();
    repo.set("team-A", "q-1", {
      status: "completed",
      last_output_at: 1_780_000_000_000,
    });
    const client = new QueriesEvidenceClient({
      queries: repo as unknown as QueriesRepository,
      teamId: "team-A",
    });
    expect(await client.getEvidence("q-1")).toEqual({
      status: "completed",
      last_output_at: 1_780_000_000_000,
    });
  });

  it("normalises an absent last_output_at to null", async () => {
    const repo = new FakeQueriesRepo();
    repo.set("team-A", "q-2", { status: "processing", last_output_at: null });
    const client = new QueriesEvidenceClient({
      queries: repo as unknown as QueriesRepository,
      teamId: "team-A",
    });
    expect(await client.getEvidence("q-2")).toEqual({
      status: "processing",
      last_output_at: null,
    });
  });

  it("only ever reads from the configured team — cross-team query is null", async () => {
    const repo = new FakeQueriesRepo();
    repo.set("team-OTHER", "q-cross", { status: "completed" });
    const client = new QueriesEvidenceClient({
      queries: repo as unknown as QueriesRepository,
      teamId: "team-A",
    });
    expect(await client.getEvidence("q-cross")).toBeNull();
    expect(repo.calls).toEqual([{ teamId: "team-A", queryId: "q-cross" }]);
  });
});
