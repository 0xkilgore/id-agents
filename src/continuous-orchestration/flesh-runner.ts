// Continuous Orchestration — flesh pass runner (daemon SELF-REFUEL).
//
// Orchestrates one auto-flesh pass: pull skeleton candidates, run the
// deterministic flesher, log every decision (append-only audit), and — unless
// dry-run — persist the generated dispatch fields, promoting safe rows to READY
// and holding risky/ambiguous ones as `needs_chris_batch`. The daemon calls this
// at a load-point when READY fuel is low; the route exposes it for manual runs.

import type { DbAdapter } from "../db/db-adapter.js";
import type { ContinuousOrchestrationConfig } from "./config.js";
import { fleshItem } from "./flesher.js";
import { FLESH_POLICY_VERSION } from "./flesh-policy.js";
import {
  insertFleshLog,
  listAllItemIds,
  listFleshCandidates,
  recordFleshOutcome,
} from "./storage.js";
import type { FleshPatch } from "./types.js";

export interface FleshRunOptions {
  dry_run?: boolean;
  limit?: number;
  item_ids?: string[];
  actor?: string;
  /** Daemon-attributed remaining budget the per-item estimate must fit under. */
  remaining_daemon_budget?: number;
  teamId?: string;
}

export interface FleshRunItemResult {
  item_id: string;
  title: string;
  ready_decision: "auto_ready" | "needs_chris_batch";
  confidence: number;
  reason: string;
  patch: FleshPatch | null;
  promoted: boolean;
}

export interface FleshRunSummary {
  dry_run: boolean;
  considered: number;
  auto_ready: number;
  needs_chris_batch: number;
  failed: number;
  results: FleshRunItemResult[];
}

/** Run one flesh pass. Pure-ish: DB writes only when `dry_run` is false. */
export async function runFleshPass(
  adapter: DbAdapter,
  config: ContinuousOrchestrationConfig,
  opts: FleshRunOptions = {},
): Promise<FleshRunSummary> {
  const teamId = opts.teamId ?? "default";
  const dryRun = !!opts.dry_run;
  const actor = opts.actor ?? "continuous-orchestration";
  const remainingBudget = opts.remaining_daemon_budget ?? Number.POSITIVE_INFINITY;

  const candidates = await listFleshCandidates(adapter, {
    team_id: teamId,
    limit: opts.limit ?? config.max_flesh_per_tick,
    item_ids: opts.item_ids,
  });
  const knownItemIds = await listAllItemIds(adapter, teamId);

  const summary: FleshRunSummary = {
    dry_run: dryRun,
    considered: candidates.length,
    auto_ready: 0,
    needs_chris_batch: 0,
    failed: 0,
    results: [],
  };

  for (const item of candidates) {
    let result;
    try {
      result = fleshItem({
        item,
        config: config.flesh,
        knownItemIds,
        remainingDaemonBudget: remainingBudget,
      });
    } catch (err) {
      summary.failed += 1;
      if (!dryRun) {
        await recordFleshOutcome(adapter, {
          item_id: item.item_id,
          flesh_status: "failed",
          flesh_source: item.source_refs[0] ?? "roadmap",
          flesh_confidence: 0,
          flesh_error: err instanceof Error ? err.message : String(err),
          policy_version: FLESH_POLICY_VERSION,
        });
        await insertFleshLog(adapter, {
          item_id: item.item_id,
          team_id: teamId,
          actor_ref: actor,
          source_ref: item.source_refs[0] ?? null,
          input_hash: item.item_id,
          decision: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const { patch } = result;
    const autoReady = patch.ready_decision === "auto_ready";
    if (autoReady) summary.auto_ready += 1;
    else summary.needs_chris_batch += 1;

    summary.results.push({
      item_id: item.item_id,
      title: item.title,
      ready_decision: patch.ready_decision,
      confidence: patch.confidence,
      reason: patch.reason,
      patch,
      promoted: autoReady && !dryRun,
    });

    if (!dryRun) {
      await recordFleshOutcome(adapter, {
        item_id: item.item_id,
        flesh_status: autoReady ? "approved_ready" : "needs_chris_batch",
        flesh_source: item.source_refs[0] ?? "roadmap",
        flesh_confidence: patch.confidence,
        policy_version: result.policy_version,
        patch,
        promote: autoReady,
      });
      await insertFleshLog(adapter, {
        item_id: item.item_id,
        team_id: teamId,
        actor_ref: actor,
        source_ref: item.source_refs[0] ?? null,
        input_hash: result.input_hash,
        output_hash: result.output_hash,
        decision: patch.ready_decision,
        reason: patch.reason,
        proposed_patch: patch,
      });
    }
  }

  return summary;
}
