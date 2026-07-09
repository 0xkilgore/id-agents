// Daemon-attributed usage (Gap 2) — buildDaemonReport rolls ONLY continuous-
// orchestration spend into the daemon ledger, and the daemon cap is decoupled
// from fleet-global burn.

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { createUsageMeterService } from "../../src/usage-meter/service.js";
import { upsertAgentUsageEvent } from "../../src/usage-meter/storage.js";
import { classifySpendScope } from "../../src/usage-meter/dispatch-spend-attribution.js";
import type { AgentUsageEvent } from "../../src/usage-meter/types.js";

const NOW = Date.parse("2026-06-22T18:00:00Z");

async function insertDispatch(adapter: SqliteAdapter, phid: string, fromActor: string): Promise<void> {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, status, not_before_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [phid, "default", `q_${phid}`, "roger", fromActor, "dispatch", "subj", "body",
     "anthropic", "claude-code-cli", "done", new Date(NOW).toISOString(), new Date(NOW).toISOString()],
  );
}

let evSeq = 0;
async function insertEvent(
  adapter: SqliteAdapter,
  opts: { dispatch_id: string | null; weighted: number; ts?: number },
): Promise<void> {
  evSeq += 1;
  const ev: AgentUsageEvent = {
    event_id: `ev_${evSeq}`,
    provider: "anthropic",
    agent_id: "roger",
    dispatch_id: opts.dispatch_id,
    query_id: null,
    session_id: null,
    model: "claude-opus-4-8",
    ts: opts.ts ?? NOW,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: opts.weighted,
    weighted_tokens: opts.weighted,
    source: "manual_ingest",
    confidence: "canonical",
    idempotency_key: `ev_${evSeq}`,
  };
  await upsertAgentUsageEvent(adapter, ev);
}

function buildService(adapter: SqliteAdapter, env: Record<string, string> = {}) {
  return createUsageMeterService({
    adapter,
    env: { CONTINUOUS_ORCHESTRATION_DAILY_CEILING: "5000000", ...env },
    now: () => NOW,
  }).service;
}

describe("classifySpendScope", () => {
  it("maps continuous-orchestration → daemon_autonomous; others → fleet", () => {
    expect(classifySpendScope("continuous-orchestration")).toBe("daemon_autonomous");
    expect(classifySpendScope("continuous-orchestration-flesher")).toBe("daemon_fleshing");
    expect(classifySpendScope("roger")).toBe("fleet");
    expect(classifySpendScope(null)).toBe("fleet");
  });
});

describe("buildDaemonReport — attribution", () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
  });

  it("rolls ONLY daemon-attributed events into the daemon ledger", async () => {
    await insertDispatch(adapter, "D_daemon", "continuous-orchestration");
    await insertDispatch(adapter, "D_roger", "roger");
    await insertEvent(adapter, { dispatch_id: "D_daemon", weighted: 1_000_000 });
    await insertEvent(adapter, { dispatch_id: "D_roger", weighted: 50_000_000 });
    await insertEvent(adapter, { dispatch_id: null, weighted: 9_000_000 });

    const service = buildService(adapter);
    const report = await service.buildDaemonReport();
    expect(report.daily.autonomous_weighted_tokens).toBe(1_000_000);
    expect(report.daily.fleshing_weighted_tokens).toBe(0);
    expect(report.daily.combined_weighted_tokens).toBe(1_000_000);
    // A busy fleet day (50M from Roger) does NOT pause the daemon: it's under cap.
    expect(report.gate.hard_paused).toBe(false);
    expect(report.coverage.attributed_events).toBe(2);
    expect(report.coverage.unknown_events).toBe(0);
    expect(report.coverage.confidence).toBe("fresh");
  });

  it("non-daemon usage does not change daemon combined tokens", async () => {
    await insertDispatch(adapter, "D_roger", "roger");
    await insertEvent(adapter, { dispatch_id: "D_roger", weighted: 99_000_000 });
    const report = await buildService(adapter).buildDaemonReport();
    expect(report.daily.combined_weighted_tokens).toBe(0);
  });

  it("daemon burn over its own reference cap warns but does not hard-pause", async () => {
    await insertDispatch(adapter, "D_daemon", "continuous-orchestration");
    await insertEvent(adapter, { dispatch_id: "D_daemon", weighted: 6_000_000 });
    const report = await buildService(adapter).buildDaemonReport();
    expect(report.daily.combined_weighted_tokens).toBe(6_000_000);
    expect(report.gate.hard_paused).toBe(false);
    expect(report.gate.reason).toMatch(/daemon daily reference exceeded/);
  });

  it("attribution degraded (dispatch row missing) is reported; fail-open by default", async () => {
    // Event references a dispatch_id with no queue row → unknown.
    await insertEvent(adapter, { dispatch_id: "D_missing", weighted: 1000 });
    const report = await buildService(adapter).buildDaemonReport();
    expect(report.coverage.unknown_events).toBe(1);
    expect(report.coverage.confidence).toBe("degraded");
    expect(report.gate.hard_paused).toBe(false);
  });

  it("attribution degraded fail-closed pauses under live enforcement", async () => {
    await insertEvent(adapter, { dispatch_id: "D_missing", weighted: 1000 });
    const service = buildService(adapter, {
      USAGE_GATE_ENFORCEMENT: "enforce",
      CONTINUOUS_ORCHESTRATION_FAIL_CLOSED_ON_ATTRIBUTION: "true",
    });
    const report = await service.buildDaemonReport();
    expect(report.coverage.confidence).toBe("degraded");
    expect(report.gate.hard_paused).toBe(true);
  });
});
