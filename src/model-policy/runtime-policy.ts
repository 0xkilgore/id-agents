// SPDX-License-Identifier: MIT

import type { DbAdapter } from "../db/db-adapter.js";
import type { ModelPolicyService } from "./policy.js";
import type { ModelChoice, Provider, Runtime } from "./types.js";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "cursor", "local", "other"];
const VALID_RUNTIMES: Runtime[] = [
  "claude-code-cli",
  "claude-agent-sdk",
  "claude-code-local",
  "codex",
  "cursor-cli",
  "openrouter",
  "public-agent-remote",
  "other",
];

export interface RuntimePolicyRow {
  team_id: string;
  logical_agent: string;
  allowed_lanes: Provider[];
  fallback_order: ModelChoice[];
  enabled: boolean;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface RuntimePolicyReadModel {
  ok: true;
  schema_version: "runtime-policy-v1";
  team_id: string;
  source: "database+model-policy" | "database";
  policies: RuntimePolicyRow[];
  effective_model_policy: {
    source: string;
    default: { agent: string; allowed_lanes: Provider[]; fallback_order: ModelChoice[] };
    agents: Array<{ agent: string; allowed_lanes: Provider[]; fallback_order: ModelChoice[] }>;
  } | null;
}

type RuntimePolicyDbRow = {
  team_id: string;
  logical_agent: string;
  allowed_lanes_json: string | Provider[];
  fallback_order_json: string | ModelChoice[];
  enabled: number | boolean;
  note: string | null;
  created_at: number | string;
  updated_at: number | string;
};

function parseJsonArray<T>(raw: string | T[] | null | undefined): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAllowedLanes(raw: string | Provider[]): Provider[] {
  const lanes = parseJsonArray<Provider>(raw).filter((p): p is Provider => VALID_PROVIDERS.includes(p as Provider));
  return [...new Set(lanes)];
}

function normalizeFallbackOrder(raw: string | ModelChoice[]): ModelChoice[] {
  return parseJsonArray<ModelChoice>(raw)
    .map((choice) => {
      const c = choice as Partial<ModelChoice>;
      if (!VALID_RUNTIMES.includes(c.runtime as Runtime) || !VALID_PROVIDERS.includes(c.provider as Provider)) {
        return null;
      }
      return {
        runtime: c.runtime as Runtime,
        model: typeof c.model === "string" ? c.model : "",
        provider: c.provider as Provider,
      };
    })
    .filter((choice): choice is ModelChoice => choice !== null);
}

function chainForPolicy(agent: string, fallbackOrder: ModelChoice[]) {
  const allowed_lanes = [...new Set(fallbackOrder.map((c) => c.provider))];
  return { agent, allowed_lanes, fallback_order: fallbackOrder };
}

export function buildRuntimePolicyReadModel(input: {
  teamId: string;
  rows: RuntimePolicyDbRow[];
  modelPolicy?: ModelPolicyService | null;
}): RuntimePolicyReadModel {
  const policies: RuntimePolicyRow[] = input.rows.map((row) => ({
    team_id: row.team_id,
    logical_agent: row.logical_agent,
    allowed_lanes: normalizeAllowedLanes(row.allowed_lanes_json),
    fallback_order: normalizeFallbackOrder(row.fallback_order_json),
    enabled: row.enabled === true || row.enabled === 1,
    note: row.note ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }));

  const effective_model_policy = input.modelPolicy
    ? {
        source: input.modelPolicy.config.source,
        default: chainForPolicy(
          input.modelPolicy.config.default.agent,
          [input.modelPolicy.config.default.primary, ...input.modelPolicy.config.default.fallback],
        ),
        agents: Object.values(input.modelPolicy.config.agents).map((p) =>
          chainForPolicy(p.agent, [p.primary, ...p.fallback]),
        ),
      }
    : null;

  return {
    ok: true,
    schema_version: "runtime-policy-v1",
    team_id: input.teamId,
    source: input.modelPolicy ? "database+model-policy" : "database",
    policies,
    effective_model_policy,
  };
}

export async function readRuntimePolicies(input: {
  adapter: DbAdapter;
  teamId: string;
  modelPolicy?: ModelPolicyService | null;
}): Promise<RuntimePolicyReadModel> {
  const rows = await input.adapter.query<RuntimePolicyDbRow>(
    `SELECT team_id, logical_agent, allowed_lanes_json, fallback_order_json, enabled, note, created_at, updated_at
     FROM agent_runtime_policy
     WHERE team_id = $1
     ORDER BY CASE WHEN logical_agent = '*' THEN 0 ELSE 1 END, logical_agent ASC`,
    [input.teamId],
  );
  return buildRuntimePolicyReadModel({ teamId: input.teamId, rows: rows.rows, modelPolicy: input.modelPolicy });
}
