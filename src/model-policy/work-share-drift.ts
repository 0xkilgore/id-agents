// Deterministic guard for configs/model-policy.json work-share drift.
//
// The authorized directive is recorded separately from the operational
// work_share target. A change to one side only is operator-visible instead of
// silently changing the standing routing directive.

import { readFileSync } from "node:fs";
import type { RuntimeMixDrift } from "./runtime-mix-drift.js";

export type WorkShareTargets = Record<string, number>;

export interface WorkShareDirectiveDrift {
  status: "match" | "drift" | "missing_directive" | "missing_work_share" | "invalid_policy";
  policy_path: string;
  directive_targets: WorkShareTargets | null;
  work_share_targets: WorkShareTargets | null;
  diffs: Array<{ provider: string; directive: number | null; work_share: number | null }>;
  message: string | null;
  runtime_mix?: RuntimeMixDrift;
}

export interface ReadWorkShareDirectiveDriftOptions {
  policyPath: string;
  readFile?: (path: string) => string;
}

function validTargets(raw: unknown): raw is WorkShareTargets {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  return entries.length > 0 && entries.every(([k, v]) => k.length > 0 && typeof v === "number" && Number.isFinite(v));
}

function diffTargets(directive: WorkShareTargets, workShare: WorkShareTargets): WorkShareDirectiveDrift["diffs"] {
  const providers = [...new Set([...Object.keys(directive), ...Object.keys(workShare)])].sort();
  return providers
    .map((provider) => ({
      provider,
      directive: Object.hasOwn(directive, provider) ? directive[provider] : null,
      work_share: Object.hasOwn(workShare, provider) ? workShare[provider] : null,
    }))
    .filter((d) => d.directive !== d.work_share);
}

function fmtTargets(targets: WorkShareTargets | null): string {
  if (!targets) return "(missing)";
  return Object.entries(targets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function evaluateWorkShareDirectiveDrift(input: {
  policyPath: string;
  directiveTargets: unknown;
  workShareTargets: unknown;
}): WorkShareDirectiveDrift {
  const directiveTargets = validTargets(input.directiveTargets) ? input.directiveTargets : null;
  const workShareTargets = validTargets(input.workShareTargets) ? input.workShareTargets : null;

  if (!directiveTargets) {
    return {
      status: "missing_directive",
      policy_path: input.policyPath,
      directive_targets: null,
      work_share_targets: workShareTargets,
      diffs: [],
      message: `model-policy authorized_directive.work_share.targets missing or invalid in ${input.policyPath}`,
    };
  }
  if (!workShareTargets) {
    return {
      status: "missing_work_share",
      policy_path: input.policyPath,
      directive_targets: directiveTargets,
      work_share_targets: null,
      diffs: [],
      message: `model-policy work_share.targets missing or invalid in ${input.policyPath}`,
    };
  }

  const diffs = diffTargets(directiveTargets, workShareTargets);
  if (diffs.length === 0) {
    return {
      status: "match",
      policy_path: input.policyPath,
      directive_targets: directiveTargets,
      work_share_targets: workShareTargets,
      diffs,
      message: null,
    };
  }

  return {
    status: "drift",
    policy_path: input.policyPath,
    directive_targets: directiveTargets,
    work_share_targets: workShareTargets,
    diffs,
    message:
      `model-policy work_share drift in ${input.policyPath}: ` +
      `authorized_directive.work_share.targets (${fmtTargets(directiveTargets)}) ` +
      `!= work_share.targets (${fmtTargets(workShareTargets)})`,
  };
}

export function readWorkShareDirectiveDrift(
  opts: ReadWorkShareDirectiveDriftOptions,
): WorkShareDirectiveDrift {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const parsed = JSON.parse(read(opts.policyPath)) as {
      authorized_directive?: { work_share?: { targets?: unknown } };
      work_share?: { targets?: unknown };
    };
    return evaluateWorkShareDirectiveDrift({
      policyPath: opts.policyPath,
      directiveTargets: parsed.authorized_directive?.work_share?.targets,
      workShareTargets: parsed.work_share?.targets,
    });
  } catch (err) {
    return {
      status: "invalid_policy",
      policy_path: opts.policyPath,
      directive_targets: null,
      work_share_targets: null,
      diffs: [],
      message: `model-policy drift guard could not read ${opts.policyPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
