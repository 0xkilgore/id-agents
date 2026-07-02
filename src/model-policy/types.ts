// D1 / T-MODEL.1 (2026-06-22) — per-agent model policy + provider fallback order.
//
// Today an agent's runtime/model is a manual edit of the agents table. This
// module makes the choice a STANDING, declarative, config-driven rule: each
// agent (and a default) declares a primary ModelChoice plus an ordered
// fallback chain. When the primary's provider lane is unavailable (e.g. Codex
// hit its usage limit), the resolver walks the chain to the first available
// provider — "Codex Light" (codex → claude) without any DB edit.
//
// The dispatch carries runtime + provider (no model field), so a ModelChoice's
// `runtime` is the effective lane decision; `model` is the advisory model that
// the runtime default already applies downstream.

import type { Provider, Runtime } from "../dispatch-scheduler/types.js";

export type { Provider, Runtime };

/** A fully-resolved (runtime, model, provider) choice. provider is always
 *  derived from runtime so the lane is internally consistent. */
export interface ModelChoice {
  runtime: Runtime;
  model: string;
  provider: Provider;
}

/** Raw config entry (configs/model-policy.json). Either `runtime` or `model`
 *  is enough — the loader fills the rest from the models metadata + runtime
 *  registry defaults. */
export interface RawModelChoice {
  runtime?: string;
  model?: string;
}

export interface RawAgentModelPolicy {
  primary: RawModelChoice;
  fallback?: RawModelChoice[];
}

export interface RawModelPolicyConfig {
  schema_version?: number;
  /** Providers automated availability derivation treats as constrained when
   *  the global usage gate is hard-paused (this is what makes Codex Light
   *  fire on usage limits). Defaults to ["openai"]. */
  constrained_providers?: string[];
  /** The default policy (applies to any agent without a specific entry). */
  default: RawAgentModelPolicy;
  /** Per-agent overrides, keyed by agent id/name. */
  agents?: Record<string, RawAgentModelPolicy>;
  /** Declared catalog of known/permitted model ids (informational enumeration;
   *  the canonical model→runtime registry is src/model-policy/metadata.ts). */
  known_models?: string[];
}

/** Normalized (loaded) per-agent policy. */
export interface AgentModelPolicy {
  agent: string; // "*" for the default
  primary: ModelChoice;
  fallback: ModelChoice[];
}

export interface ModelPolicyConfig {
  schema_version: 1;
  constrained_providers: Provider[];
  default: AgentModelPolicy;
  agents: Record<string, AgentModelPolicy>;
  /** Declared catalog of known/permitted model ids from the config (deduped). */
  known_models: string[];
  /** Where the config came from — for the read API + diagnostics. */
  source: "file" | "builtin_default";
}

export type ResolveSource = "primary" | "fallback" | "primary_forced";

export interface ResolvedModel {
  agent: string;
  choice: ModelChoice;
  source: ResolveSource;
  fallback_applied: boolean;
  reason: string;
  /** Which policy matched: the agent key, or "*" for the default. */
  policy_agent: string;
  /** The full chain considered (primary first), for transparency. */
  considered: ModelChoice[];
}

/** The seam the scheduler's enqueue path consumes. */
export interface ModelPolicyResolver {
  resolveModelChoice(input: { agent: string; unavailableProviders?: Provider[] }): ResolvedModel;
  constrainedProviders(): Provider[];
}
