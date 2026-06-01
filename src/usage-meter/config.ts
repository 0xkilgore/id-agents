// Usage Meter — budget policy loader.
//
// Resolution: env USAGE_BUDGET_POLICY_PATH > configs/usage-budget-policy.json
// > compiled defaults. NEVER crashes — invalid input degrades to defaults.

import { readFileSync, existsSync } from "node:fs";
import type { UsageBudgetPolicy } from "./types.js";

export const DEFAULT_USAGE_BUDGET_POLICY: UsageBudgetPolicy = Object.freeze({
  schema_version: "usage-budget-policy.v1",
  timezone: "America/Chicago",
  provider: "anthropic",
  global: {
    // Conservative defaults — small enough that operators will notice
    // soft warnings before any real burn, but large enough that real
    // overnight aggregate runs don't soft-warn immediately if the
    // operator hasn't configured a policy file yet.
    daily_weighted_tokens: 10_000_000,
    weekly_weighted_tokens: 50_000_000,
    soft_threshold_pct: 0.8,
    hard_threshold_pct: 1.0,
  },
  agents: {},
  exempt_agents: ["manager", "sentinel"],
  emergency_override: { enabled: false, reason: null, expires_at: null },
  fail_closed_on_unknown: true,
}) as UsageBudgetPolicy;

export interface LoadPolicyOptions {
  env?: { USAGE_BUDGET_POLICY_PATH?: string };
  configsPath?: string;
}

export interface LoadPolicyResult {
  policy: UsageBudgetPolicy;
  source: "env_path" | "configs_file" | "defaults";
  degraded: boolean;
  degraded_reason?: string;
  resolved_path?: string;
}

export function loadUsageBudgetPolicy(opts: LoadPolicyOptions = {}): LoadPolicyResult {
  const envPath = opts.env?.USAGE_BUDGET_POLICY_PATH;
  if (envPath) {
    return loadFromPath(envPath, "env_path");
  }
  if (opts.configsPath && existsSync(opts.configsPath)) {
    return loadFromPath(opts.configsPath, "configs_file");
  }
  return { policy: DEFAULT_USAGE_BUDGET_POLICY, source: "defaults", degraded: false };
}

function loadFromPath(
  path: string,
  source: "env_path" | "configs_file",
): LoadPolicyResult {
  if (!existsSync(path)) {
    return {
      policy: DEFAULT_USAGE_BUDGET_POLICY,
      source: "defaults",
      degraded: true,
      degraded_reason: `policy file not found: ${path}`,
      resolved_path: path,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      policy: DEFAULT_USAGE_BUDGET_POLICY,
      source: "defaults",
      degraded: true,
      degraded_reason: `failed to read policy file: ${err instanceof Error ? err.message : String(err)}`,
      resolved_path: path,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      policy: DEFAULT_USAGE_BUDGET_POLICY,
      source: "defaults",
      degraded: true,
      degraded_reason: `policy json parse failed: ${err instanceof Error ? err.message : String(err)}`,
      resolved_path: path,
    };
  }
  const validation = validatePolicy(parsed);
  if (!validation.ok) {
    return {
      policy: DEFAULT_USAGE_BUDGET_POLICY,
      source: "defaults",
      degraded: true,
      degraded_reason: validation.reason,
      resolved_path: path,
    };
  }
  return {
    policy: validation.policy,
    source,
    degraded: false,
    resolved_path: path,
  };
}

type ValidationResult =
  | { ok: true; policy: UsageBudgetPolicy }
  | { ok: false; reason: string };

function validatePolicy(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "policy must be an object" };
  }
  const o = input as Record<string, unknown>;
  if (o.schema_version !== "usage-budget-policy.v1") {
    return {
      ok: false,
      reason: `invalid schema_version (expected "usage-budget-policy.v1", got ${JSON.stringify(o.schema_version)})`,
    };
  }
  if (typeof o.timezone !== "string" || !o.timezone) {
    return { ok: false, reason: "timezone must be a non-empty string" };
  }
  if (o.provider !== "anthropic" && o.provider !== "openai" && o.provider !== "other") {
    return { ok: false, reason: `invalid provider ${JSON.stringify(o.provider)}` };
  }
  const g = o.global as Record<string, unknown> | undefined;
  if (!g || typeof g !== "object") {
    return { ok: false, reason: "global budget required" };
  }
  if (!Number.isFinite(g.daily_weighted_tokens) || (g.daily_weighted_tokens as number) < 0) {
    return { ok: false, reason: "global.daily_weighted_tokens must be a non-negative finite number" };
  }
  if (!Number.isFinite(g.weekly_weighted_tokens) || (g.weekly_weighted_tokens as number) < 0) {
    return { ok: false, reason: "global.weekly_weighted_tokens must be a non-negative finite number" };
  }
  const soft = g.soft_threshold_pct;
  const hard = g.hard_threshold_pct;
  if (typeof soft !== "number" || soft < 0 || soft > 1) {
    return { ok: false, reason: "global.soft_threshold_pct must be in [0, 1]" };
  }
  if (typeof hard !== "number" || hard < 0 || hard > 1) {
    return { ok: false, reason: "global.hard_threshold_pct must be in [0, 1]" };
  }
  if (!o.agents || typeof o.agents !== "object") {
    return { ok: false, reason: "agents must be an object" };
  }
  if (!Array.isArray(o.exempt_agents)) {
    return { ok: false, reason: "exempt_agents must be an array" };
  }
  if (!o.emergency_override || typeof o.emergency_override !== "object") {
    return { ok: false, reason: "emergency_override required" };
  }

  // Validate per-agent budgets.
  for (const [agentId, agentBudget] of Object.entries(o.agents as Record<string, unknown>)) {
    if (!agentBudget || typeof agentBudget !== "object") {
      return { ok: false, reason: `agents.${agentId} must be an object` };
    }
    const a = agentBudget as Record<string, unknown>;
    if (!Number.isFinite(a.daily_weighted_tokens) || (a.daily_weighted_tokens as number) < 0) {
      return { ok: false, reason: `agents.${agentId}.daily_weighted_tokens must be non-negative finite` };
    }
    if (!Number.isFinite(a.weekly_weighted_tokens) || (a.weekly_weighted_tokens as number) < 0) {
      return { ok: false, reason: `agents.${agentId}.weekly_weighted_tokens must be non-negative finite` };
    }
  }

  return { ok: true, policy: input as UsageBudgetPolicy };
}
