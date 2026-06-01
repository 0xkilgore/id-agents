// Usage Meter — storage tests (sqlite).
// Idempotent event insertion, rollup upsert, gate-decision audit append.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  upsertAgentUsageEvent,
  listRecentAgentUsageEvents,
  upsertAgentUsageRollup,
  getAgentUsageRollup,
  insertUsageGateDecision,
  listRecentUsageGateDecisions,
} from "../../src/usage-meter/storage.js";
import type { AgentUsageEvent } from "../../src/usage-meter/types.js";

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "usage-meter-storage-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<AgentUsageEvent> = {}): AgentUsageEvent {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    provider: "anthropic",
    agent_id: "roger",
    dispatch_id: null,
    query_id: null,
    session_id: null,
    model: "claude-sonnet-4-6",
    ts: Date.parse("2026-05-31T18:00:00.000Z"),
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: 150,
    weighted_tokens: 150,
    source: "claude_code_transcripts",
    confidence: "canonical",
    idempotency_key: `idem_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe("upsertAgentUsageEvent", () => {
  it("inserts a fresh event", async () => {
    const e = makeEvent({ idempotency_key: "ik-1" });
    const r = await upsertAgentUsageEvent(adapter, e);
    expect(r.inserted).toBe(true);
    const list = await listRecentAgentUsageEvents(adapter, { limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]?.agent_id).toBe("roger");
  });

  it("is idempotent by idempotency_key (does NOT duplicate)", async () => {
    const a = makeEvent({ idempotency_key: "dup-key", weighted_tokens: 100 });
    const b = makeEvent({ idempotency_key: "dup-key", weighted_tokens: 200 });
    await upsertAgentUsageEvent(adapter, a);
    const r = await upsertAgentUsageEvent(adapter, b);
    expect(r.inserted).toBe(false);
    const list = await listRecentAgentUsageEvents(adapter, { limit: 10 });
    expect(list).toHaveLength(1);
    // First write wins (idempotent — we don't overwrite).
    expect(list[0]?.weighted_tokens).toBe(100);
  });

  it("filters listRecentAgentUsageEvents by since_ms", async () => {
    const old = makeEvent({ idempotency_key: "old", ts: Date.parse("2026-05-01T00:00:00.000Z") });
    const fresh = makeEvent({ idempotency_key: "fresh", ts: Date.parse("2026-05-31T18:00:00.000Z") });
    await upsertAgentUsageEvent(adapter, old);
    await upsertAgentUsageEvent(adapter, fresh);
    const recent = await listRecentAgentUsageEvents(adapter, {
      since_ms: Date.parse("2026-05-29T00:00:00.000Z"),
      limit: 10,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.idempotency_key).toBe("fresh");
  });
});

describe("upsertAgentUsageRollup / getAgentUsageRollup", () => {
  it("upserts a rollup row (insert + later update)", async () => {
    const r1 = {
      provider: "anthropic" as const,
      agent_id: "roger",
      window_kind: "day" as const,
      window_start: "2026-05-31T00:00:00.000-05:00",
      window_end: "2026-06-01T00:00:00.000-05:00",
      raw_tokens: 100,
      weighted_tokens: 100,
      requests: 1,
      models: ["claude-sonnet-4-6"],
      source_coverage: { claude_code_transcripts: 1 },
      computed_at: "2026-05-31T18:00:00.000-05:00",
    };
    await upsertAgentUsageRollup(adapter, r1);
    await upsertAgentUsageRollup(adapter, { ...r1, weighted_tokens: 250, raw_tokens: 250, requests: 2 });
    const got = await getAgentUsageRollup(adapter, {
      provider: "anthropic",
      agent_id: "roger",
      window_kind: "day",
      window_start: "2026-05-31T00:00:00.000-05:00",
    });
    expect(got?.weighted_tokens).toBe(250);
    expect(got?.requests).toBe(2);
  });

  it("getAgentUsageRollup returns null when not present", async () => {
    const got = await getAgentUsageRollup(adapter, {
      provider: "anthropic",
      agent_id: "ghost",
      window_kind: "day",
      window_start: "2026-05-31T00:00:00.000-05:00",
    });
    expect(got).toBeNull();
  });
});

describe("insertUsageGateDecision / listRecentUsageGateDecisions", () => {
  it("appends a global decision row with metadata", async () => {
    await insertUsageGateDecision(adapter, {
      id: "dec-1",
      ts: Date.parse("2026-05-31T18:00:00.000Z"),
      scope: "global",
      agent_id: null,
      state: "normal",
      decision: "allow",
      reason: "under budgets",
      daily_pct: 0.42,
      weekly_pct: 0.31,
      policy_version: "usage-budget-policy.v1",
      metadata: { foo: "bar" },
    });
    const rows = await listRecentUsageGateDecisions(adapter, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("dec-1");
    expect(rows[0]?.scope).toBe("global");
    expect(rows[0]?.metadata).toEqual({ foo: "bar" });
  });

  it("preserves agent_id for agent-scope decisions", async () => {
    await insertUsageGateDecision(adapter, {
      id: "dec-roger",
      ts: Date.now(),
      scope: "agent",
      agent_id: "roger",
      state: "hard_paused",
      decision: "pause_agent",
      reason: "roger daily exhausted",
      daily_pct: 1.0,
      weekly_pct: 0.5,
      policy_version: "usage-budget-policy.v1",
      metadata: {},
    });
    const rows = await listRecentUsageGateDecisions(adapter, { limit: 10, agent_id: "roger" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe("roger");
  });
});
