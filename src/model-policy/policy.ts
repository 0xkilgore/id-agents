// D1 / T-MODEL.1 — model-policy loader + resolver.
//
// loadModelPolicy() reads configs/model-policy.json (+ optional
// configs/models-metadata.json), normalizes every raw entry into a fully
// resolved ModelChoice, and returns a ModelPolicyService. The service is the
// standing, config-driven rule: resolveModelChoice() walks an agent's
// primary→fallback chain and returns the first choice whose provider lane is
// available. No agents-table edit required to change an agent's runtime/model
// or its fallback order — edit the config.

import { readFileSync } from "node:fs";
import type { Provider, Runtime } from "../dispatch-scheduler/types.js";
import { normalizeRuntime, resolveProviderFromRuntime } from "../dispatch-scheduler/types.js";
import { getDefaultRuntime } from "../runtime/registry.js";
import {
  buildModelsMetadata,
  defaultModelForRuntime,
  ModelsMetadata,
  type RawModelMetadataRow,
} from "./metadata.js";
import type {
  AgentModelPolicy,
  ModelChoice,
  ModelPolicyConfig,
  ModelPolicyResolver,
  RawAgentModelPolicy,
  RawModelChoice,
  RawModelPolicyConfig,
  ResolvedModel,
} from "./types.js";

export const DEFAULT_CONSTRAINED_PROVIDERS: Provider[] = ["openai"];

// Built-in "Codex Light" default used when no config file is present: agents
// run on Codex (OpenAI) and fall back to Claude (Anthropic) when the openai
// lane is constrained.
const BUILTIN_DEFAULT: RawModelPolicyConfig = {
  schema_version: 1,
  constrained_providers: ["openai"],
  default: {
    primary: { runtime: "codex" },
    fallback: [{ runtime: "claude-code-cli" }],
  },
  agents: {},
};

function normalizeProviderList(raw: string[] | undefined): Provider[] {
  if (raw === undefined) return [...DEFAULT_CONSTRAINED_PROVIDERS];
  if (raw.length === 0) return [];
  const valid: Provider[] = ["anthropic", "openai", "cursor", "local", "other"];
  const out = raw.filter((p): p is Provider => valid.includes(p as Provider));
  return out.length > 0 ? out : [...DEFAULT_CONSTRAINED_PROVIDERS];
}

/** Normalize the declared known-models catalog: trimmed, non-empty, deduped,
 *  order-preserving. Absent/invalid → empty list. */
function normalizeKnownModels(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m !== "string") continue;
    const id = m.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Resolve a raw {runtime?,model?} entry into a complete ModelChoice. */
function normalizeChoice(raw: RawModelChoice, metadata: ModelsMetadata): ModelChoice {
  // Prefer an explicit runtime; else resolve the runtime from the model via
  // the metadata catalog; else fall back to the registry default runtime.
  if (raw.runtime) {
    const runtime = normalizeRuntime(raw.runtime);
    return {
      runtime,
      model: raw.model ?? defaultModelForRuntime(runtime),
      provider: resolveProviderFromRuntime(runtime),
    };
  }
  if (raw.model) {
    const meta = metadata.lookup(raw.model);
    if (meta) {
      return { runtime: meta.runtime, model: meta.model, provider: meta.provider };
    }
  }
  const runtime = normalizeRuntime(getDefaultRuntime());
  return {
    runtime,
    model: raw.model ?? defaultModelForRuntime(runtime),
    provider: resolveProviderFromRuntime(runtime),
  };
}

function normalizeAgentPolicy(
  agent: string,
  raw: RawAgentModelPolicy,
  metadata: ModelsMetadata,
): AgentModelPolicy {
  return {
    agent,
    primary: normalizeChoice(raw.primary, metadata),
    fallback: (raw.fallback ?? []).map((c) => normalizeChoice(c, metadata)),
  };
}

export class ModelPolicyService implements ModelPolicyResolver {
  readonly config: ModelPolicyConfig;
  readonly metadata: ModelsMetadata;

  constructor(config: ModelPolicyConfig, metadata: ModelsMetadata) {
    this.config = config;
    this.metadata = metadata;
  }

  constrainedProviders(): Provider[] {
    return [...this.config.constrained_providers];
  }

  /** The declared known/permitted model ids from the config (may be empty). */
  knownModels(): string[] {
    return [...this.config.known_models];
  }

  /** The policy that applies to an agent (specific entry or the default). */
  policyForAgent(agent: string): AgentModelPolicy {
    return this.config.agents[agent] ?? this.config.default;
  }

  resolveModelChoice(input: { agent: string; unavailableProviders?: Provider[] }): ResolvedModel {
    const policy = this.policyForAgent(input.agent);
    const considered = [policy.primary, ...policy.fallback];
    const unavailable = new Set(input.unavailableProviders ?? []);

    for (let i = 0; i < considered.length; i++) {
      const choice = considered[i];
      if (!unavailable.has(choice.provider)) {
        return {
          agent: input.agent,
          choice,
          source: i === 0 ? "primary" : "fallback",
          fallback_applied: i > 0,
          reason:
            i === 0
              ? `primary ${choice.runtime} (${choice.provider}) available`
              : `primary lane constrained → fallback #${i} ${choice.runtime} (${choice.provider})`,
          policy_agent: policy.agent,
          considered,
        };
      }
    }

    // Every provider in the chain is constrained — there is nowhere better to
    // route, so use the primary (forced) and let the lane gate handle it.
    return {
      agent: input.agent,
      choice: considered[0],
      source: "primary_forced",
      fallback_applied: false,
      reason: "all providers in chain constrained; using primary",
      policy_agent: policy.agent,
      considered,
    };
  }
}

export interface LoadModelPolicyOptions {
  /** Absolute path to model-policy.json. Missing/invalid → builtin Codex Light. */
  configPath?: string;
  /** Absolute path to a Models.dev-shaped models-metadata.json (optional). */
  metadataPath?: string;
  /** Injectable reader for tests; defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Diagnostics sink (defaults to console.warn). */
  onWarn?: (msg: string) => void;
}

/** Pure builder — normalize a raw config + metadata into a service. */
export function buildModelPolicyService(
  raw: RawModelPolicyConfig,
  source: ModelPolicyConfig["source"],
  metadataOverrides: RawModelMetadataRow[] = [],
): ModelPolicyService {
  const metadata = buildModelsMetadata(metadataOverrides);
  const config: ModelPolicyConfig = {
    schema_version: 1,
    constrained_providers: normalizeProviderList(raw.constrained_providers),
    default: normalizeAgentPolicy("*", raw.default, metadata),
    agents: Object.fromEntries(
      Object.entries(raw.agents ?? {}).map(([agent, p]) => [agent, normalizeAgentPolicy(agent, p, metadata)]),
    ),
    known_models: normalizeKnownModels(raw.known_models),
    source,
  };
  return new ModelPolicyService(config, metadata);
}

/** Load from disk; never throws — a missing/broken file degrades to the
 *  builtin Codex Light default so the manager always has a policy. */
export function loadModelPolicy(opts: LoadModelPolicyOptions = {}): ModelPolicyService {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[model-policy] ${m}`));

  let metadataOverrides: RawModelMetadataRow[] = [];
  if (opts.metadataPath) {
    try {
      const parsed = JSON.parse(read(opts.metadataPath)) as { models?: RawModelMetadataRow[] } | RawModelMetadataRow[];
      metadataOverrides = Array.isArray(parsed) ? parsed : parsed.models ?? [];
    } catch {
      /* optional — absent is fine */
    }
  }

  if (!opts.configPath) {
    return buildModelPolicyService(BUILTIN_DEFAULT, "builtin_default", metadataOverrides);
  }
  try {
    const raw = JSON.parse(read(opts.configPath)) as RawModelPolicyConfig;
    if (!raw.default || !raw.default.primary) {
      warn("config missing default.primary; using builtin Codex Light default");
      return buildModelPolicyService(BUILTIN_DEFAULT, "builtin_default", metadataOverrides);
    }
    return buildModelPolicyService(raw, "file", metadataOverrides);
  } catch (err) {
    warn(`failed to load ${opts.configPath} (${err instanceof Error ? err.message : String(err)}); using builtin default`);
    return buildModelPolicyService(BUILTIN_DEFAULT, "builtin_default", metadataOverrides);
  }
}

export type { ModelPolicyResolver } from "./types.js";
