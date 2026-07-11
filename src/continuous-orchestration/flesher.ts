// Continuous Orchestration — deterministic auto-flesher (daemon SELF-REFUEL).
//
// Turns an imported roadmap SKELETON (title + track, null dispatch fields) into
// a dispatch-ready FleshPatch WITHOUT an LLM: it assigns the owner lane + write
// scope from the configured lane map, generates a canonical dispatch body that
// passes the validator, scores a deterministic confidence, and asks the
// auto-ready policy whether the result is safe to fire unattended.
//
// Pure + fully unit-tested. A non-LLM flesher is the safe V0 (Non-Goal: "do not
// make an LLM decide destructive/external work is safe") and keeps refuel
// reproducible: same skeleton + config => same patch.

import crypto from "node:crypto";
import type { FleshConfig, FleshLane } from "./config.js";
import {
  evaluateAutoReady,
  matchesHighRiskDenylist,
  validateFleshPatch,
  FLESH_POLICY_VERSION,
  type ValidateFleshPatchOptions,
} from "./flesh-policy.js";
import type { BacklogItem, FleshPatch, RiskClass } from "./types.js";

export interface FleshInput {
  item: BacklogItem;
  config: FleshConfig;
  /** item_ids known to the backlog (dependency resolution for auto-ready). */
  knownItemIds: Set<string>;
  /** Daemon-attributed remaining budget the estimate must fit under. */
  remainingDaemonBudget: number;
  /** Extra roadmap prose for context (optional; not required for V0). */
  roadmapContext?: string;
}

export interface FleshResult {
  patch: FleshPatch;
  policy_version: string;
  input_hash: string;
  output_hash: string;
  validation_errors: string[];
}

function sha8(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Pick the lane whose `tracks` prefix-matches the item's track; else default. */
export function resolveLane(track: string | null, config: FleshConfig): FleshLane {
  if (track) {
    const t = track.toUpperCase();
    for (const lane of config.lanes) {
      if (lane.tracks.some((p) => t.startsWith(p.toUpperCase()))) return lane;
    }
  }
  return config.default_lane;
}

/** Strip the "T-XXX — " prefix to recover the human description of a skeleton. */
function descriptionOf(item: BacklogItem): string {
  const title = item.title ?? "";
  const dash = title.split(/—|–| - /);
  const desc = (dash.length > 1 ? dash.slice(1).join(" - ") : title).trim();
  return desc || title;
}

/** Bracketed track tag for the dispatch body, e.g. "[T-ORCH.2]". */
function trackTag(item: BacklogItem): string {
  const t = (item.track ?? "").trim();
  return t ? `[${t}]` : "[T-?]";
}

/**
 * Deterministic confidence. The dominant signal is whether the skeleton's track
 * routes to a RECOGNIZED lane (a configured lane, not the catch-all default):
 * known roadmap tracks in a known lane clear the auto-ready bar; novel/unknown
 * tracks stay below it and route to Chris's approval batch. A high-risk phrase
 * floors confidence to 0 so such work can never auto-ready.
 */
export function scoreConfidence(item: BacklogItem, lane: FleshLane, config: FleshConfig): number {
  if (matchesHighRiskDenylist(item.title, descriptionOf(item))) return 0;
  const matchedLane = resolveLane(item.track, config);
  const isRecognizedTrack = matchedLane !== config.default_lane;
  let c = 0.5;
  if (isRecognizedTrack) c += 0.32; // recognized track in a known lane is the bar
  if (descriptionOf(item).length >= 12) c += 0.1; // a substantive description
  if (item.source_refs.length > 0) c += 0.05; // provenance present
  if (lane.write_scopes.length === 0) c -= 0.3; // no single-writer scope is a red flag
  return Math.min(1, Math.max(0, Number(c.toFixed(4))));
}

function authoredTargetAgent(item: BacklogItem): string | null {
  const target = item.to_agent?.trim();
  return target && target.length > 0 ? target : null;
}

/** Build the canonical Kapelle dispatch body for a skeleton. */
export function generateDispatchBody(
  item: BacklogItem,
  lane: FleshLane,
  config: FleshConfig,
  targetAgent = lane.agent,
): string {
  const desc = descriptionOf(item);
  const src = item.source_refs[0] ? ` (per ${item.source_refs[0]})` : "";
  return (
    `[project: ${config.project}]${trackTag(item)}[BUILD] ` +
    `${targetAgent}: implement "${desc}"${src}. ` +
    `Read the existing code first, make the smallest change that works, and add unit tests. ` +
    `Verify with \`npm run build && npm test\` (clean tsc build + green vitest) before reporting done. ` +
    `Spec 054 v2 promotion to main required after green unless the dispatcher sets promote:false.`
  );
}

/** Build the ValidateFleshPatchOptions from the flesh config. */
export function validateOptionsFromConfig(config: FleshConfig): ValidateFleshPatchOptions {
  const knownAgents = new Set<string>([config.default_lane.agent, ...config.lanes.map((l) => l.agent)]);
  const knownWriteScopes = new Set<string>([
    ...config.default_lane.write_scopes,
    ...config.lanes.flatMap((l) => l.write_scopes),
  ]);
  return {
    knownAgents,
    knownWriteScopes,
    maxTokenEstimate: config.max_token_estimate,
    projectTag: config.project,
  };
}

/**
 * Flesh one skeleton into a dispatch-ready patch + an auto-ready decision.
 * Deterministic: identical input + config yields an identical patch and hashes.
 */
export function fleshItem(input: FleshInput): FleshResult {
  const { item, config } = input;
  const lane = resolveLane(item.track, config);
  const risk_class: RiskClass = config.default_risk_class;
  const targetAgent = authoredTargetAgent(item) ?? lane.agent;
  const authoredDispatchBody =
    typeof item.dispatch_body === "string" && item.dispatch_body.trim().length > 0 ? item.dispatch_body : null;
  const dispatch_body = authoredDispatchBody ?? generateDispatchBody(item, lane, config, targetAgent);
  const confidence = scoreConfidence(item, lane, config);

  const validate = validateOptionsFromConfig(config);
  validate.knownAgents.add(targetAgent);

  // Provisional patch (ready_decision filled by the policy below).
  const patch: FleshPatch = {
    to_agent: targetAgent,
    dispatch_body,
    risk_class,
    write_scope: lane.write_scopes.length > 0 ? [lane.write_scopes[0]] : [],
    dependencies: [...item.dependencies],
    token_estimate: config.default_token_estimate,
    provider: config.default_provider,
    runtime: config.default_runtime,
    value_score: item.value_score,
    priority: item.priority,
    confidence,
    ready_decision: "needs_chris_batch",
    reason: "",
  };

  const decision = evaluateAutoReady({
    patch,
    sourceTitle: item.title,
    knownItemIds: input.knownItemIds,
    remainingDaemonBudget: input.remainingDaemonBudget,
    validate,
  });
  patch.ready_decision = decision.ready_decision;
  patch.reason =
    decision.ready_decision === "auto_ready"
      ? "all auto-ready checks passed"
      : decision.reasons.join("; ");

  const validation_errors = validateFleshPatch(patch, validate);
  const input_hash = sha8(`${item.item_id}|${item.title}|${item.track}|${JSON.stringify(item.dependencies)}`);
  const output_hash = sha8(JSON.stringify(patch));

  return { patch, policy_version: FLESH_POLICY_VERSION, input_hash, output_hash, validation_errors };
}
