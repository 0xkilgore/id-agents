// Usage Meter — service + route integration tests.
//
// Verifies the public /usage v2 contract, the WARN-ONLY default
// (no blocking), and the fail-safe degraded paths.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  createUsageMeterService,
  UsageMeterService,
} from "../../src/usage-meter/service.js";
import { mountUsageMeterRoutes } from "../../src/usage-meter/routes.js";
import { upsertAgentUsageEvent } from "../../src/usage-meter/storage.js";
import type { AgentUsageEvent } from "../../src/usage-meter/types.js";

let tmpDir: string;
let adapter: SqliteAdapter;

const FIXED_NOW = Date.parse("2026-05-31T18:00:00.000Z");

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "usage-meter-service-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkService(env: NodeJS.ProcessEnv = {}): UsageMeterService {
  const { service } = createUsageMeterService({
    adapter,
    env,
    now: () => FIXED_NOW,
  });
  return service;
}

function mkApp(service: UsageMeterService): Express {
  const app = express();
  app.use(express.json());
  mountUsageMeterRoutes(app, { service });
  return app;
}

async function ingestEvent(overrides: Partial<AgentUsageEvent> = {}): Promise<void> {
  const ev: AgentUsageEvent = {
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    provider: "anthropic",
    agent_id: "roger",
    dispatch_id: null,
    query_id: null,
    session_id: null,
    model: "claude-sonnet-4-6",
    ts: FIXED_NOW - 60_000,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: 150,
    weighted_tokens: 150,
    source: "claude_code_transcripts",
    confidence: "canonical",
    idempotency_key: `ik_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
  await upsertAgentUsageEvent(adapter, ev);
}

// ─────────────────────────────────────────────────────────────────────
// WARN-ONLY defaults
// ─────────────────────────────────────────────────────────────────────

describe("UsageMeterService — WARN-ONLY default", () => {
  it("snapshot.enforcement defaults to 'warn' when USAGE_GATE_ENFORCEMENT is unset", async () => {
    const svc = mkService();
    const snap = await svc.snapshot();
    expect(snap.enforcement).toBe("warn");
  });

  it("getExcludedAgentsForClaim returns [] when warn (even with huge usage)", async () => {
    // Spike roger past every conceivable budget.
    await ingestEvent({ weighted_tokens: 999_999_999, raw_tokens: 999_999_999 });
    const svc = mkService();
    await svc.refreshRollups();
    expect(await svc.getExcludedAgentsForClaim()).toEqual([]);
  });

  it("isAgentPaused returns false in warn mode regardless of usage", async () => {
    await ingestEvent({ weighted_tokens: 999_999_999 });
    const svc = mkService();
    await svc.refreshRollups();
    expect(await svc.isAgentPaused("roger")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Enforce mode behavior
// ─────────────────────────────────────────────────────────────────────

describe("UsageMeterService — enforce mode (opt-in)", () => {
  it("getExcludedAgentsForClaim excludes overspent agents when enforce", async () => {
    // Build a policy file with low budgets so roger blows past hard.
    const policyFile = join(tmpDir, "policy.json");
    writeFileSync(policyFile, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "America/Chicago",
      provider: "anthropic",
      global: { daily_weighted_tokens: 10_000, weekly_weighted_tokens: 10_000, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
      agents: { roger: { daily_weighted_tokens: 100, weekly_weighted_tokens: 100, priority: "worker" } },
      exempt_agents: ["manager", "sentinel"],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    await ingestEvent({ weighted_tokens: 5_000, raw_tokens: 5_000 });

    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: policyFile, USAGE_GATE_ENFORCEMENT: "enforce" },
      now: () => FIXED_NOW,
    });
    await service.refreshRollups();
    const excluded = await service.getExcludedAgentsForClaim();
    expect(excluded).toContain("roger");
  });

  it("emergency override env vars activate the override", async () => {
    const { service } = createUsageMeterService({
      adapter,
      env: {
        USAGE_GATE_ENFORCEMENT: "enforce",
        USAGE_GATE_OVERRIDE_UNTIL: "2099-01-01T00:00:00.000Z",
        USAGE_GATE_OVERRIDE_REASON: "test override",
      },
      now: () => FIXED_NOW,
    });
    const snap = await service.snapshot();
    expect(snap.override_active).toBe(true);
    expect(snap.global.decision).toBe("allow");
  });
});

// ─────────────────────────────────────────────────────────────────────
// /usage v2 contract
// ─────────────────────────────────────────────────────────────────────

describe("GET /usage — v2 schema contract", () => {
  it("returns usage-meter-v2 with all required top-level keys", async () => {
    const svc = mkService();
    const app = mkApp(svc);
    const res = await request(app).get("/usage");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("usage-meter-v2");
    expect(res.body.source).toBe("manager-usage-meter");
    expect(res.body.windows.daily.start).toBeDefined();
    expect(res.body.windows.weekly.start).toBeDefined();
    expect(res.body.usage.daily.budget).toBeGreaterThan(0);
    expect(res.body.usage.weekly.budget).toBeGreaterThan(0);
    expect(Array.isArray(res.body.by_agent)).toBe(true);
    expect(Array.isArray(res.body.by_model)).toBe(true);
    expect(res.body.concurrency).toBeDefined();
    expect(res.body.gate).toBeDefined();
    expect(res.body.gate.enforcement).toBe("warn");
    expect(res.body.gate.should_pause_new_dispatches).toBe(false);
  });

  it("reports daily.percent_consumed reflecting ingested events", async () => {
    const policyFile = join(tmpDir, "policy.json");
    writeFileSync(policyFile, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "America/Chicago",
      provider: "anthropic",
      global: { daily_weighted_tokens: 1000, weekly_weighted_tokens: 10_000, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    await ingestEvent({ weighted_tokens: 500, raw_tokens: 500 });

    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: policyFile },
      now: () => FIXED_NOW,
    });
    await service.refreshRollups();

    const app = mkApp(service);
    const res = await request(app).get("/usage");
    expect(res.status).toBe(200);
    expect(res.body.usage.daily.weighted_tokens).toBe(500);
    expect(res.body.usage.daily.percent_consumed).toBeCloseTo(0.5);
  });

  it("GET /usage/gate returns a snapshot", async () => {
    const svc = mkService();
    const app = mkApp(svc);
    const res = await request(app).get("/usage/gate");
    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
    expect(res.body.enforcement).toBe("warn");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Degraded paths
// ─────────────────────────────────────────────────────────────────────

describe("UsageMeterService — degraded fail-safe", () => {
  it("policy file invalid → service still serves a report (degraded note in calibration)", async () => {
    const bad = join(tmpDir, "bad-policy.json");
    writeFileSync(bad, "{ not valid json");
    const { service } = createUsageMeterService({
      adapter,
      env: { USAGE_BUDGET_POLICY_PATH: bad },
      now: () => FIXED_NOW,
    });
    const report = await service.buildReport();
    expect(report.schema_version).toBe("usage-meter-v2");
    expect(report.calibration.notes).toMatch(/degraded|defaults/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tiny supertest-like helper (avoid the extra dep)
// ─────────────────────────────────────────────────────────────────────

function request(app: Express) {
  return {
    async get(path: string): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
            const text = await r.text();
            let body: any;
            try { body = JSON.parse(text); } catch { body = text; }
            server.close(() => resolve({ status: r.status, body }));
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });
    },
  };
}
