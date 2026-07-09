// Dispatch Scheduler — Usage Gate integration.
// Verifies the WARN-ONLY default + ENFORCE mode + fail-safe carve-outs.

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SchedulerHandle } from "../../src/dispatch-scheduler/manager-integration.js";
import { createUsageMeterService } from "../../src/usage-meter/service.js";
import { upsertAgentUsageEvent } from "../../src/usage-meter/storage.js";
import { writeFileSync } from "node:fs";

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-usage-gate-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

function policyFile(overrides: Record<string, unknown> = {}): string {
  const path = join(tmpDir, "policy.json");
  writeFileSync(path, JSON.stringify({
    schema_version: "usage-budget-policy.v1",
    timezone: "America/Chicago",
    provider: "anthropic",
    global: { daily_weighted_tokens: 10_000, weekly_weighted_tokens: 50_000, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
    agents: { roger: { daily_weighted_tokens: 100, weekly_weighted_tokens: 500, priority: "worker" } },
    exempt_agents: ["manager", "sentinel"],
    emergency_override: { enabled: false, reason: null, expires_at: null },
    ...overrides,
  }));
  return path;
}

async function ingestHugeRogerUsage(): Promise<void> {
  await upsertAgentUsageEvent(adapter, {
    event_id: "evt-1",
    provider: "anthropic",
    agent_id: "roger",
    dispatch_id: null,
    query_id: null,
    session_id: null,
    model: "claude-sonnet-4-6",
    ts: Date.now() - 60_000,
    input_tokens: 999_999,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: 999_999,
    weighted_tokens: 999_999,
    source: "claude_code_transcripts",
    confidence: "canonical",
    idempotency_key: "ik-1",
  });
}

async function insertActiveProviderLimitBounce(agent = "roger"): Promise<void> {
  const nowIso = new Date().toISOString();
  const nextIso = new Date(Date.now() + 30 * 60_000).toISOString();
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
      dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
      subject, body_markdown, provider, runtime, priority, status,
      not_before_at, attempt_count, bounce_count, last_bounce_json,
      bounce_history_json, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `phid:disp-${Math.random().toString(16).slice(2)}`,
      "team",
      `query_${Math.random().toString(36).slice(2)}`,
      agent,
      "schedule",
      "talk",
      "provider limit",
      "body",
      "anthropic",
      "claude-code-cli",
      5,
      "bounced",
      nextIso,
      1,
      1,
      JSON.stringify({
        ts: nowIso,
        kind: "provider_limit",
        message: "Claude limited until reset",
        next_attempt_at: nextIso,
        attempt: 1,
      }),
      "[]",
      nowIso,
    ],
  );
}

describe("Scheduler usage-gate integration", () => {
  it("WARN-ONLY default: even with budget exhausted, claim still picks up roger", async () => {
    const policyPath = policyFile();
    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: policyPath /* no USAGE_GATE_ENFORCEMENT */ },
      now: () => Date.now(),
    });
    await ingestHugeRogerUsage();
    await service.refreshRollups();
    // Confirm enforcement is warn:
    const snap = await service.getSnapshotForScheduler();
    expect(snap.enforcement).toBe("warn");
    expect(snap.agents.roger?.state).toBe("soft_warning"); // configured-token overage is a warning
    // But excluded list is empty in warn mode:
    expect(await service.getExcludedAgentsForClaim()).toEqual([]);

    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
    });
    handle.scheduler.setUsageGateProvider({
      getSnapshotForScheduler: () => service.getSnapshotForScheduler(),
      getExcludedAgentsForClaim: () => service.getExcludedAgentsForClaim(),
    });

    await handle.enqueue({ to_agent: "roger", from_actor: "test", message: "hi" });

    // Mock transport - just return a fake agent_query_id so the doc moves in_flight.
    const originalSendTalk = handle.scheduler["transport"].sendTalk.bind(handle.scheduler["transport"]);
    handle.scheduler["transport"].sendTalk = async () => ({ ok: true as const, agent_query_id: "aq-1" });

    const report = await handle.scheduler.tick();
    handle.scheduler["transport"].sendTalk = originalSendTalk;

    expect(report.usage_gate?.enforcement).toBe("warn");
    expect(report.usage_gate?.excluded_agents).toEqual([]);
    expect(report.started).toBe(1); // roger was claimed despite budget exhausted
  });

  it("ENFORCE mode: configured token overage does not exclude or block claims", async () => {
    const policyPath = policyFile();
    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: policyPath, USAGE_GATE_ENFORCEMENT: "enforce" },
      now: () => Date.now(),
    });
    await ingestHugeRogerUsage();
    await service.refreshRollups();

    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
    });
    handle.scheduler.setUsageGateProvider({
      getSnapshotForScheduler: () => service.getSnapshotForScheduler(),
      getExcludedAgentsForClaim: () => service.getExcludedAgentsForClaim(),
    });

    const enq = await handle.enqueue({ to_agent: "roger", from_actor: "test", message: "hi" });
    handle.scheduler["transport"].sendTalk = async () => ({ ok: true as const, agent_query_id: "aq-1" });
    const report = await handle.scheduler.tick();

    expect(report.usage_gate?.enforcement).toBe("enforce");
    expect(report.usage_gate?.excluded_agents).toEqual([]);
    expect(report.started).toBe(1);

    // Doc starts normally; configured tokens are not a real provider limit.
    const got = await handle.client.getByQueryId(enq.query_id);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.status).toBe("in_flight");
  });

  it("ENFORCE mode: active provider limit excludes non-exempt agents but leaves exempt agents startable", async () => {
    // Drive global budget over hard threshold using a giant _global event
    // (via an agent that's NOT in the exempt list). Roger is in the
    // policy so the gate knows it exists and can pause it; the queue
    // doesn't have to teach the gate about every agent.
    const policyPath = policyFile({
      agents: { roger: { daily_weighted_tokens: 1_000_000, weekly_weighted_tokens: 1_000_000, priority: "worker" } },
    });
    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: policyPath, USAGE_GATE_ENFORCEMENT: "enforce" },
      now: () => Date.now(),
    });
    await ingestHugeRogerUsage();
    await insertActiveProviderLimitBounce("roger");
    await service.refreshRollups();

    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
    });
    handle.scheduler.setUsageGateProvider({
      getSnapshotForScheduler: () => service.getSnapshotForScheduler(),
      getExcludedAgentsForClaim: () => service.getExcludedAgentsForClaim(),
    });

    // Enqueue both an exempt agent (manager) and a non-exempt (roger).
    await handle.enqueue({ to_agent: "manager", from_actor: "test", message: "x" });
    await handle.enqueue({ to_agent: "roger", from_actor: "test", message: "y" });

    handle.scheduler["transport"].sendTalk = async () => ({ ok: true as const, agent_query_id: "aq-x" });
    const report = await handle.scheduler.tick();

    // Roger should be excluded (real provider limit); manager is exempt.
    expect(report.usage_gate?.excluded_agents).toContain("roger");
    expect(report.usage_gate?.excluded_agents).not.toContain("manager");
  });

  it("gate provider error: scheduler does NOT throw, falls back to no exclusions", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
    });
    handle.scheduler.setUsageGateProvider({
      getSnapshotForScheduler: async () => {
        throw new Error("gate provider blew up");
      },
      getExcludedAgentsForClaim: async () => {
        throw new Error("nope");
      },
    });

    await handle.enqueue({ to_agent: "roger", from_actor: "test", message: "hi" });
    handle.scheduler["transport"].sendTalk = async () => ({ ok: true as const, agent_query_id: "aq-1" });
    const report = await handle.scheduler.tick();
    expect(report.usage_gate?.error).toMatch(/gate provider blew up/);
    expect(report.started).toBe(1); // never blocks on error
  });

  it("no usage gate provider injected: scheduler behaves as before (no gating)", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:1",
    });
    // No setUsageGateProvider() call.
    await handle.enqueue({ to_agent: "roger", from_actor: "test", message: "hi" });
    handle.scheduler["transport"].sendTalk = async () => ({ ok: true as const, agent_query_id: "aq-1" });
    const report = await handle.scheduler.tick();
    expect(report.usage_gate).toBeUndefined();
    expect(report.started).toBe(1);
  });
});
