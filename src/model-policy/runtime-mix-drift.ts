// Deterministic guard for desired-vs-actual runtime/model mix drift.
//
// Compares the desired provider share in configs/model-policy.json against
// independently generated runtime-mode config and live agent runtime telemetry.

import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { normalizeRuntime, resolveProviderFromRuntime, type Provider } from "../dispatch-scheduler/types.js";

export type ProviderTargets = Partial<Record<Provider, number>>;

export interface RuntimeMixSourceDrift {
  source: "runtime_mode" | "agent_actual";
  provider: Provider;
  desired: number;
  actual: number;
  delta: number;
}

export interface RuntimeMixObservation {
  total: number;
  runtimes: Record<string, number>;
  providers: ProviderTargets;
}

export interface RuntimeMixDrift {
  status:
    | "match"
    | "drift"
    | "missing_policy_targets"
    | "missing_runtime_mode"
    | "invalid_policy"
    | "invalid_runtime_mode";
  policy_path: string;
  runtime_mode_path: string | null;
  tolerance: number;
  desired_targets: ProviderTargets | null;
  runtime_mode_actual: RuntimeMixObservation | null;
  agent_actual: RuntimeMixObservation | null;
  diffs: RuntimeMixSourceDrift[];
  message: string | null;
}

export interface ReadRuntimeMixDriftOptions {
  policyPath: string;
  runtimeModePath?: string | null;
  actualAgentRuntimes?: Map<string, string> | Record<string, string> | Array<{ agent?: string; name?: string; runtime?: string }> | null;
  tolerance?: number;
  readFile?: (path: string) => string;
}

const DEFAULT_TOLERANCE = 0.001;
const PROVIDERS: Provider[] = ["anthropic", "openai", "cursor", "local", "other"];

function validTargets(raw: unknown): ProviderTargets | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ProviderTargets = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROVIDERS.includes(provider as Provider)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    out[provider as Provider] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function fmtTargets(targets: ProviderTargets | null): string {
  if (!targets) return "(missing)";
  return PROVIDERS
    .filter((p) => targets[p] !== undefined)
    .map((p) => `${p}=${targets[p]}`)
    .join(", ");
}

function observationFromRuntimes(runtimes: string[]): RuntimeMixObservation | null {
  if (runtimes.length === 0) return null;
  const runtimeCounts: Record<string, number> = {};
  const providerCounts: ProviderTargets = {};
  for (const raw of runtimes) {
    const runtime = normalizeRuntime(raw);
    runtimeCounts[runtime] = (runtimeCounts[runtime] ?? 0) + 1;
    const provider = resolveProviderFromRuntime(runtime);
    providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
  }
  const total = runtimes.length;
  const providers: ProviderTargets = {};
  for (const provider of PROVIDERS) {
    const count = providerCounts[provider] ?? 0;
    if (count > 0) providers[provider] = count / total;
  }
  return { total, runtimes: runtimeCounts, providers };
}

function collectRuntimeStrings(raw: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, keyHint = ""): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }

    const obj = node as Record<string, unknown>;
    const runtime = obj.runtime ?? obj.actual_runtime ?? obj.actualRuntime ?? obj.runtime_mode ?? obj.runtimeMode;
    if (typeof runtime === "string" && runtime.trim()) out.push(runtime);

    for (const [key, value] of Object.entries(obj)) {
      if (key === "agents" || key === "agent_runtimes" || key === "runtime_policy" || key === "runtime_modes") {
        visit(value, key);
      } else if (keyHint && value && typeof value === "object") {
        visit(value, key);
      }
    }
  };
  visit(raw);
  return out;
}

function actualRuntimesToObservation(input: ReadRuntimeMixDriftOptions["actualAgentRuntimes"]): RuntimeMixObservation | null {
  if (!input) return null;
  if (input instanceof Map) return observationFromRuntimes([...input.values()]);
  if (Array.isArray(input)) {
    return observationFromRuntimes(input.map((row) => row.runtime).filter((r): r is string => !!r));
  }
  return observationFromRuntimes(Object.values(input).filter((r): r is string => typeof r === "string" && r.length > 0));
}

function diffsForSource(
  source: RuntimeMixSourceDrift["source"],
  desired: ProviderTargets,
  actual: RuntimeMixObservation | null,
  tolerance: number,
): RuntimeMixSourceDrift[] {
  if (!actual) return [];
  return PROVIDERS
    .map((provider) => {
      const desiredValue = desired[provider] ?? 0;
      const actualValue = actual.providers[provider] ?? 0;
      return { source, provider, desired: desiredValue, actual: actualValue, delta: actualValue - desiredValue };
    })
    .filter((d) => Math.abs(d.delta) > tolerance);
}

export function evaluateRuntimeMixDrift(input: {
  policyPath: string;
  runtimeModePath: string | null;
  desiredTargets: unknown;
  runtimeModeRuntimes?: string[] | null;
  actualAgentRuntimes?: ReadRuntimeMixDriftOptions["actualAgentRuntimes"];
  tolerance?: number;
}): RuntimeMixDrift {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const desiredTargets = validTargets(input.desiredTargets);
  if (!desiredTargets) {
    return {
      status: "missing_policy_targets",
      policy_path: input.policyPath,
      runtime_mode_path: input.runtimeModePath,
      tolerance,
      desired_targets: null,
      runtime_mode_actual: null,
      agent_actual: null,
      diffs: [],
      message: `model-policy work_share.targets missing or invalid in ${input.policyPath}`,
    };
  }

  const runtimeModeActual =
    input.runtimeModeRuntimes === undefined ? null : observationFromRuntimes(input.runtimeModeRuntimes ?? []);
  const agentActual = actualRuntimesToObservation(input.actualAgentRuntimes);
  const diffs = [
    ...diffsForSource("runtime_mode", desiredTargets, runtimeModeActual, tolerance),
    ...diffsForSource("agent_actual", desiredTargets, agentActual, tolerance),
  ];

  if (diffs.length === 0) {
    return {
      status: "match",
      policy_path: input.policyPath,
      runtime_mode_path: input.runtimeModePath,
      tolerance,
      desired_targets: desiredTargets,
      runtime_mode_actual: runtimeModeActual,
      agent_actual: agentActual,
      diffs,
      message: null,
    };
  }

  return {
    status: "drift",
    policy_path: input.policyPath,
    runtime_mode_path: input.runtimeModePath,
    tolerance,
    desired_targets: desiredTargets,
    runtime_mode_actual: runtimeModeActual,
    agent_actual: agentActual,
    diffs,
    message:
      `model-policy runtime mix drift: desired work_share.targets (${fmtTargets(desiredTargets)}) ` +
      `differs from ${diffs.map((d) => `${d.source}.${d.provider}=${d.actual}`).join(", ")}`,
  };
}

export function readRuntimeMixDrift(opts: ReadRuntimeMixDriftOptions): RuntimeMixDrift {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  let desiredTargets: unknown;
  try {
    const policy = JSON.parse(read(opts.policyPath)) as { work_share?: { targets?: unknown } };
    desiredTargets = policy.work_share?.targets;
  } catch (err) {
    return {
      status: "invalid_policy",
      policy_path: opts.policyPath,
      runtime_mode_path: opts.runtimeModePath ?? null,
      tolerance,
      desired_targets: null,
      runtime_mode_actual: null,
      agent_actual: null,
      diffs: [],
      message: `model-policy runtime mix guard could not read ${opts.policyPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let runtimeModeRuntimes: string[] | undefined;
  if (opts.runtimeModePath) {
    if (!opts.readFile && !existsSync(opts.runtimeModePath)) {
      return {
        status: "missing_runtime_mode",
        policy_path: opts.policyPath,
        runtime_mode_path: opts.runtimeModePath,
        tolerance,
        desired_targets: validTargets(desiredTargets),
        runtime_mode_actual: null,
        agent_actual: actualRuntimesToObservation(opts.actualAgentRuntimes),
        diffs: [],
        message: `runtime-mode generated config missing at ${opts.runtimeModePath}`,
      };
    }
    try {
      const parsed = yaml.load(read(opts.runtimeModePath));
      runtimeModeRuntimes = collectRuntimeStrings(parsed);
    } catch (err) {
      return {
        status: "invalid_runtime_mode",
        policy_path: opts.policyPath,
        runtime_mode_path: opts.runtimeModePath,
        tolerance,
        desired_targets: validTargets(desiredTargets),
        runtime_mode_actual: null,
        agent_actual: actualRuntimesToObservation(opts.actualAgentRuntimes),
        diffs: [],
        message: `runtime-mode drift guard could not read ${opts.runtimeModePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return evaluateRuntimeMixDrift({
    policyPath: opts.policyPath,
    runtimeModePath: opts.runtimeModePath ?? null,
    desiredTargets,
    runtimeModeRuntimes,
    actualAgentRuntimes: opts.actualAgentRuntimes,
    tolerance,
  });
}
