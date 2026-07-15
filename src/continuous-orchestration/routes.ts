// Continuous Orchestration — Express routes (read-only status + steering).
//
// Mounts under the manager management app next to /usage. Provides the kill
// switch / mode controls, the manual (dry-run) tick trigger, the backlog +
// approval-gate endpoints, and the decision-log audit feed.

import fs from "node:fs";
import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  AUTO_PROMOTE_HEALTH_STALE_ALREADY_DISPATCHED_STATUSES,
  type AutoPromoteHealth,
  type ContinuousOrchestrationDaemon,
  type ReadyAdmissionExplanation,
} from "./daemon.js";
import type { ContinuousOrchestrationConfig } from "./config.js";
import { AUTO_READY_CONFIDENCE_THRESHOLD } from "./flesh-policy.js";
import type { OrchestrationMode, ReadinessState } from "./types.js";
import {
  countFleshLogSince,
  findProbableDuplicateByRegisterId,
  getBacklogItem,
  getDispatchOutcomesByPhid,
  getDispatchStatusesByPhid,
  getFleshCounts,
  insertBacklogItem,
  insertBacklogItemIfAbsentByLogicalKey,
  insertFleshLog,
  listBacklogByState,
  listHeldConfidenceReviewItems,
  listFleshLog,
  listRecentDecisions,
  markFailedDuplicateDispatchRetrySafe,
  promoteToReady,
  reconcileOfflineSupersededReadyRow,
  reconcileStaleAlreadyDispatchedReadyRows,
  recordFleshOutcome,
  setItemState,
  updateBacklogFields,
  type NewBacklogItem,
} from "./storage.js";
import { attachBacklogRetryReadiness } from "./backlog-retry-readiness.js";
import type { RiskClass } from "./types.js";
import { autoPromoteRejections } from "./auto-promote-policy.js";
import { buildStaleDuplicateBacklogReport } from "./stale-duplicate-report.js";
import { buildDuplicateDispatchRetryClassificationReport } from "./duplicate-dispatch-retry-classifier.js";
import { parseRoadmapToBacklog } from "./roadmap-import.js";
import { runFleshPass } from "./flesh-runner.js";
import { resolveTrack } from "../track-registry/registry.js";
import { readOrchestrationHealthProjection } from "./health-projection.js";
import { readReleaseProofReadiness } from "./release-proof-readiness.js";
import { DEFAULT_ACTOR_ID } from "../lib/default-actor.js";

export interface OrchestrationRouteOptions {
  daemon: ContinuousOrchestrationDaemon;
  adapter: DbAdapter;
  config: ContinuousOrchestrationConfig;
  teamId?: string;
  runtimeHealth?: () => RuntimeHealthSource;
}

type NeedsPromoteSkipClass = "already_dispatched" | "confidence_threshold" | "review_held_risk";

export interface RuntimeHealthSource {
  disk?: { state?: string | null } | null;
  build?: { behind_origin?: boolean | null } | null;
}

export interface RuntimeStatusProjection {
  schema_version: "orchestration.runtime_status_projection.v1";
  disk_critical: boolean;
  disk_state: string | null;
  build_behind_origin: boolean | null;
  capacity_full: boolean;
  ready_count: number;
  raw_ready_fuel: number;
  useful_ready_fuel: number;
  admissible_now: number;
  operator_summary: string;
  recommended_actions: string[];
}

export function buildRuntimeStatusProjection(input: {
  runtimeHealth?: RuntimeHealthSource | null;
  autoPromoteHealth: AutoPromoteHealth;
  readyAdmission: ReadyAdmissionExplanation;
}): RuntimeStatusProjection {
  const diskState = input.runtimeHealth?.disk?.state ?? null;
  const diskCritical = diskState === "critical";
  const buildBehindOrigin = input.runtimeHealth?.build?.behind_origin ?? null;
  const capacityFull =
    input.autoPromoteHealth.lanes.capacity_occupied ||
    input.readyAdmission.blocker_counts.some((count) =>
      count.category === "capacity_gate" && count.count > 0,
    );
  const recommendedActions: string[] = [];
  if (diskCritical) recommendedActions.push("clear disk headroom before dispatching or handing off");
  if (buildBehindOrigin === true) recommendedActions.push("deploy/promote the current manager build before Chris handoff");
  if (capacityFull) recommendedActions.push("wait for in-flight build capacity to free or close completed dispatches");
  if (input.readyAdmission.admissible_now > 0) recommendedActions.push("admit currently admissible ready rows");
  if (recommendedActions.length === 0) recommendedActions.push(input.readyAdmission.recommended_action);

  const infraFirst = diskCritical || buildBehindOrigin === true;
  const operatorSummary = infraFirst
    ? `disk/deploy unblock before Chris handoff: ${recommendedActions.join("; ")}`
    : `ready=${input.readyAdmission.candidates} admissible=${input.readyAdmission.admissible_now}; ${input.readyAdmission.recommended_action}`;

  return {
    schema_version: "orchestration.runtime_status_projection.v1",
    disk_critical: diskCritical,
    disk_state: diskState,
    build_behind_origin: buildBehindOrigin,
    capacity_full: capacityFull,
    ready_count: input.readyAdmission.candidates,
    raw_ready_fuel: input.readyAdmission.candidates,
    useful_ready_fuel: input.readyAdmission.useful_ready,
    admissible_now: input.readyAdmission.admissible_now,
    operator_summary: operatorSummary,
    recommended_actions: recommendedActions,
  };
}

function classifyNeedsPromoteSkip(reasons: string[]): NeedsPromoteSkipClass | null {
  if (reasons.some((r) => r.includes("already dispatched once"))) return "already_dispatched";
  if (reasons.some((r) => r.includes("flesh_confidence") || r.includes("confidence "))) {
    return "confidence_threshold";
  }
  if (reasons.length > 0) return "review_held_risk";
  return null;
}

function withReadyAdmissionOperatorSummary(
  health: AutoPromoteHealth,
  readyAdmission: ReadyAdmissionExplanation,
): AutoPromoteHealth {
  const unhealthyTargets = readyAdmission.blocker_counts.find((count) => count.code === "target_unhealthy")?.count ?? 0;
  if (unhealthyTargets === 0 || readyAdmission.admissible_now === 0) return health;

  const groupExamples = readyAdmission.target_unhealthy_groups.slice(0, 3).map((group) =>
    `${group.target} on ${group.lane} (${group.count})`,
  );
  const exampleText = groupExamples.length > 0 ? `: ${groupExamples.join("; ")}` : "";
  const action =
    `Reroute, downclassify/supersede, or restart owners for ${unhealthyTargets} target_unhealthy ready row(s) where safe${exampleText}; ` +
    "keep admitting available pool rows while capacity exists, and top off compatible pool fuel only if healthy capacity runs short.";
  const safeActions = health.operator_summary.safe_actions.includes(action)
    ? health.operator_summary.safe_actions
    : [action, ...health.operator_summary.safe_actions];
  return {
    ...health,
    operator_summary: {
      ...health.operator_summary,
      safe_actions: safeActions,
      empty_fuel: false,
      summary: `${health.operator_summary.summary}; ready admission has ${readyAdmission.admissible_now} admissible row(s) alongside ${unhealthyTargets} target_unhealthy row(s); safe actions: ${action}`,
    },
  };
}

export function mountContinuousOrchestrationRoutes(app: Application, opts: OrchestrationRouteOptions): void {
  const teamId = opts.teamId ?? "default";
  const { daemon, adapter, config } = opts;

  app.get("/orchestration/status", async (_req: Request, res: Response) => {
    try {
      const state = await daemon.getState();
      const confidenceThreshold = AUTO_READY_CONFIDENCE_THRESHOLD;
      const [ready, needsReview, heldConfidenceReview, inFlight, needsChrisBatch, fleshCounts] = await Promise.all([
        listBacklogByState(adapter, { team_id: teamId, state: "ready" }),
        listBacklogByState(adapter, { team_id: teamId, state: "needs_review" }),
        listHeldConfidenceReviewItems(adapter, { team_id: teamId, confidence_threshold: confidenceThreshold }),
        listBacklogByState(adapter, { team_id: teamId, state: "in_flight" }),
        listBacklogByState(adapter, { team_id: teamId, state: "needs_chris_batch" }),
        getFleshCounts(adapter, teamId),
      ]);
      // Auto-fleshed today = approved_ready flesh-log decisions since local midnight.
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const autoFleshedToday = await countFleshLogSince(adapter, {
        team_id: teamId,
        since_iso: startOfDay.toISOString(),
        decision: "auto_ready",
      });
      const baseAutoPromoteHealth = await daemon.explainAutoPromoteHealth();
      const readyAdmission = await daemon.explainReadyAdmission();
      const autoPromoteHealth = withReadyAdmissionOperatorSummary(
        baseAutoPromoteHealth,
        readyAdmission,
      );
      const runtime_status = buildRuntimeStatusProjection({
        runtimeHealth: opts.runtimeHealth?.() ?? null,
        autoPromoteHealth,
        readyAdmission,
      });
      const needsReviewDispatchStatuses = await getDispatchStatusesByPhid(
        adapter,
        needsReview.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
      );
      const staleAlreadyDispatchedNeedsReview = needsReview.filter((item) => {
        if (!item.last_dispatch_phid) return false;
        const status = needsReviewDispatchStatuses.get(item.last_dispatch_phid);
        return !!status && AUTO_PROMOTE_HEALTH_STALE_ALREADY_DISPATCHED_STATUSES.has(status);
      });
      const usefulNeedsReview = Math.max(
        0,
        needsReview.length - heldConfidenceReview.length - staleAlreadyDispatchedNeedsReview.length,
      );
      const health = await readOrchestrationHealthProjection(adapter, teamId, {
        minReadyFuel: config.min_ready_fuel,
        readyAdmission: {
          rawReady: readyAdmission.candidates,
          usefulReady: readyAdmission.useful_ready,
          admissibleNow: readyAdmission.admissible_now,
          blockerCounts: readyAdmission.blocker_counts,
          nonAdmitted: readyAdmission.non_admitted.map((item) => ({
            item_id: item.item_id,
            code: item.code,
          })),
          blockedLanes: readyAdmission.blocked_lanes,
          recommendedAction: readyAdmission.recommended_action,
        },
      });
      let killSwitch = false;
      try {
        killSwitch = fs.existsSync(config.kill_switch_path);
      } catch {
        /* ignore */
      }
      res.json({
        ok: true,
        config: {
          enabled: config.enabled,
          dry_run: config.dry_run,
          daily_token_ceiling: config.daily_token_ceiling,
          max_in_flight: config.max_in_flight,
          max_new_per_tick: config.max_new_per_tick,
          stall_threshold_ticks: config.stall_threshold_ticks,
          cadence_load_points: config.cadence_load_points,
          timezone: config.timezone,
          kill_switch_path: config.kill_switch_path,
        },
        state,
        kill_switch_active: killSwitch,
        counts: {
          ready: ready.length,
          raw_ready_fuel: readyAdmission.candidates,
          useful_ready_fuel: readyAdmission.useful_ready,
          admissible_now: readyAdmission.admissible_now,
          raw_ready_lanes: readyAdmission.lanes.raw_ready,
          useful_ready_lanes: readyAdmission.lanes.useful_ready,
          admissible_lanes: readyAdmission.lanes.admissible_now,
          stale_ready_fuel: readyAdmission.stale_ready_floor.stale,
          ready_block_reasons: readyAdmission.block_reason_counts,
          top_ready_block_reasons: readyAdmission.top_block_reasons,
          needs_review: usefulNeedsReview,
          stale_needs_review: staleAlreadyDispatchedNeedsReview.length,
          held_confidence_review: heldConfidenceReview.length,
          in_flight: inFlight.length,
          needs_chris_batch: needsChrisBatch.length,
          unfleshed: fleshCounts.unfleshed ?? 0,
          auto_fleshed_today: autoFleshedToday,
        },
        flesh: {
          enabled: config.auto_flesh_enabled,
          min_ready_fuel: config.min_ready_fuel,
          min_ready_lanes: config.min_ready_lanes,
          auto_promote: {
            enabled: config.auto_promote_enabled,
            floor: config.auto_promote_floor,
            min_lanes: config.auto_promote_min_lanes,
            max_per_tick: config.auto_promote_max_per_tick,
            confidence_threshold: confidenceThreshold,
            health: autoPromoteHealth,
          },
          by_status: fleshCounts,
        },
        auto_promote_health: autoPromoteHealth,
        ready_admission: readyAdmission,
        runtime_status,
        health,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/health", async (_req: Request, res: Response) => {
    try {
      res.json(await readOrchestrationHealthProjection(adapter, teamId));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/release-proof-readiness", async (req: Request, res: Response) => {
    try {
      const project = typeof req.query.project === "string" && req.query.project.trim()
        ? req.query.project.trim()
        : "kapelle";
      res.json(await readReleaseProofReadiness(adapter, { teamId, project }));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const modeRoute = (path: string, mode: OrchestrationMode, clearAutoPause = false) => {
    app.post(path, async (_req: Request, res: Response) => {
      try {
        await daemon.setMode(mode, { clear_auto_pause: clearAutoPause });
        res.json({ ok: true, mode });
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };
  modeRoute("/orchestration/pause", "paused");
  modeRoute("/orchestration/resume", "running", true);
  modeRoute("/orchestration/drain", "drain_only");
  modeRoute("/orchestration/stop", "stopped");

  // Manual single tick — the dry-run trigger for the audit-before-arm rollout.
  app.post("/orchestration/tick", async (_req: Request, res: Response) => {
    try {
      const result = await daemon.runTick();
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/orchestration/reconcile/stale-ready", async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const dryRun = body?.dry_run === true;
      const actor = typeof body.actor === "string"
        ? body.actor
        : typeof body.closed_by === "string"
          ? body.closed_by
          : DEFAULT_ACTOR_ID;
      const result = await reconcileStaleAlreadyDispatchedReadyRows(adapter, { team_id: teamId, dry_run: dryRun, actor });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/orchestration/reconcile/offline-superseded-ready", async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const itemId = typeof body.item_id === "string" ? body.item_id : "";
      const supersedingCoitemId = typeof body.superseding_coitem_id === "string"
        ? body.superseding_coitem_id
        : typeof body.superseding_item_id === "string"
          ? body.superseding_item_id
          : "";
      const reason = typeof body.reason === "string" ? body.reason : "";
      const actor = typeof body.actor === "string"
        ? body.actor
        : typeof body.closed_by === "string"
          ? body.closed_by
          : DEFAULT_ACTOR_ID;
      const result = await reconcileOfflineSupersededReadyRow(adapter, {
        team_id: teamId,
        item_id: itemId,
        superseding_coitem_id: supersedingCoitemId,
        reason,
        actor,
        dry_run: body.dry_run === true,
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/backlog", async (req: Request, res: Response) => {
    try {
      const state = typeof req.query.state === "string" ? (req.query.state as ReadinessState) : undefined;
      const items = await listBacklogByState(adapter, { team_id: teamId, state });
      const outcomes = await getDispatchOutcomesByPhid(
        adapter,
        items.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
      );
      res.json({ ok: true, items: attachBacklogRetryReadiness(items, outcomes) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/backlog/needs-promote-report", async (_req: Request, res: Response) => {
    try {
      const items = await listBacklogByState(adapter, { team_id: teamId, state: "needs_review" });
      const dispatchStatuses = await getDispatchStatusesByPhid(
        adapter,
        items.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
      );
      const groups: Record<
        NeedsPromoteSkipClass,
        {
          count: number;
          items: Array<{
            item_id: string;
            title: string;
            reasons: string[];
            prior_dispatch_phid?: string;
            prior_dispatch_status?: string | null;
          }>;
        }
      > = {
        already_dispatched: { count: 0, items: [] },
        confidence_threshold: { count: 0, items: [] },
        review_held_risk: { count: 0, items: [] },
      };
      let autoPromotable = 0;
      const autoPromotableItems: Array<{ item_id: string; title: string }> = [];

      for (const item of items) {
        const reasons = autoPromoteRejections(item, AUTO_READY_CONFIDENCE_THRESHOLD);
        const klass = classifyNeedsPromoteSkip(reasons);
        if (!klass) {
          autoPromotable += 1;
          autoPromotableItems.push({ item_id: item.item_id, title: item.title });
          continue;
        }
        const priorDispatchPhid = item.last_dispatch_phid ?? undefined;
        groups[klass].items.push({
          item_id: item.item_id,
          title: item.title,
          reasons,
          ...(priorDispatchPhid
            ? {
                prior_dispatch_phid: priorDispatchPhid,
                prior_dispatch_status: dispatchStatuses.get(priorDispatchPhid) ?? null,
              }
            : {}),
        });
      }

      for (const group of Object.values(groups)) group.count = group.items.length;
      res.json({
        ok: true,
        total_needs_review: items.length,
        auto_promotable: autoPromotable,
        auto_promotable_items: autoPromotableItems,
        counts: {
          already_dispatched: groups.already_dispatched.count,
          confidence_threshold: groups.confidence_threshold.count,
          review_held_risk: groups.review_held_risk.count,
        },
        groups,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/backlog/stale-duplicates", async (_req: Request, res: Response) => {
    try {
      const [needsReview, ready] = await Promise.all([
        listBacklogByState(adapter, { team_id: teamId, state: "needs_review" }),
        listBacklogByState(adapter, { team_id: teamId, state: "ready" }),
      ]);
      const items = [...needsReview, ...ready];
      const outcomes = await getDispatchOutcomesByPhid(
        adapter,
        items.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
      );
      res.json({ ok: true, report: buildStaleDuplicateBacklogReport(items, outcomes) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/backlog/duplicate-dispatch-retry-blockers", async (_req: Request, res: Response) => {
    try {
      const items = await listBacklogByState(adapter, { team_id: teamId, state: "ready" });
      const outcomes = await getDispatchOutcomesByPhid(
        adapter,
        items.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
      );
      res.json({ ok: true, report: buildDuplicateDispatchRetryClassificationReport(items, outcomes) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/orchestration/backlog", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as NewBacklogItem & { force?: boolean };
      if (!body.title) return res.status(400).json({ ok: false, error: "title required" });
      // Validate the item's track against the canonical-track-registry. A
      // provided-but-non-conforming track is DRIFT: warn + tag, never block.
      let trackDrift = false;
      if (body.track != null && typeof body.track === "string" && body.track.trim() !== "") {
        const resolved = resolveTrack(body.track);
        if (!resolved.conforms) {
          trackDrift = true;
          console.warn(
            `[orchestration] POST /orchestration/backlog: non-conforming track "${body.track}" — ingesting with track_drift=1 (see canonical-track-registry)`,
          );
        }
      }
      // Defensive cross-check: this endpoint is hit directly by external
      // authors (e.g. maestra's refuel-wave scripts) that mint a fresh
      // logical_key per item, so the exact-logical_key dedup elsewhere never
      // catches a re-authored duplicate referencing the same
      // kapelle-feedback-register.md entry under a different key. Caller can
      // set `force: true` to insert anyway (e.g. a register item that was
      // genuinely reopened).
      if (!body.force) {
        const dup = await findProbableDuplicateByRegisterId(adapter, teamId, {
          title: body.title,
          source_refs: body.source_refs ?? null,
        });
        if (dup) {
          return res.status(409).json({
            ok: false,
            error: "probable_duplicate",
            message:
              `A backlog item referencing the same register ID already exists ` +
              `(item_id=${dup.item_id}, readiness_state=${dup.readiness_state}). ` +
              `Pass force:true to insert anyway.`,
            existing_item: dup,
          });
        }
      }
      // New items NEVER land ready — only the approval gate can do that.
      const safe: NewBacklogItem = {
        ...body,
        team_id: teamId,
        readiness_state: body.readiness_state === "ready" ? "needs_review" : body.readiness_state ?? "draft",
        track_drift: trackDrift,
      };
      const item = await insertBacklogItem(adapter, safe);
      res.json({ ok: true, item });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The human approval gate: needs_review/draft -> READY. Optionally attach the
  // dispatch body/agent + admission metadata in the same call.
  app.post("/orchestration/backlog/:id/promote", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const approvedBy = typeof body.approved_by === "string" && body.approved_by ? body.approved_by : DEFAULT_ACTOR_ID;
      const patch = body.patch && typeof body.patch === "object" ? (body.patch as Partial<NewBacklogItem>) : undefined;
      if (patch) await updateBacklogFields(adapter, id, patch);
      const result = await promoteToReady(adapter, id, approvedBy, { retry_safe: body.retry_safe === true });
      if (!result.ok) return res.status(409).json({ ok: false, error: result.reason });
      res.json({ ok: true, item: result.item });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/orchestration/backlog/:id/mark-retry-safe", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actor =
        typeof body.actor_ref === "string" && body.actor_ref
          ? body.actor_ref
          : typeof body.actor === "string" && body.actor
            ? body.actor
            : typeof body.updated_by === "string" && body.updated_by
              ? body.updated_by
              : "";
      const reason = typeof body.reason === "string" ? body.reason : "";
      const result = await markFailedDuplicateDispatchRetrySafe(adapter, id, { actor, reason, team_id: teamId });
      if (!result.ok) {
        return res.status(result.status).json({
          ok: false,
          error: result.error,
          reason: result.reason,
          item: result.item,
          retry_count: result.retry_count,
          retry_cap: result.retry_cap,
        });
      }
      res.json({ ok: true, item: result.item, retry_count: result.retry_count });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Partial update of a backlog item's dispatchable fields — lets skeleton
  // (imported) items get populated before promotion (the daemon-enable path).
  // Idempotent (same body => same state) and actor-attributed (updated_by).
  // Only the dispatchable fields below are accepted; readiness_state is NOT
  // mutable here (promotion is the only path to `ready`).
  app.patch("/orchestration/backlog/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const existing = await getBacklogItem(adapter, id);
      if (!existing) return res.status(404).json({ ok: false, error: "backlog item not found" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const actor =
        typeof body.actor_ref === "string" && body.actor_ref
          ? body.actor_ref
          : typeof body.actor === "string" && body.actor
            ? body.actor
            : typeof body.updated_by === "string" && body.updated_by
              ? body.updated_by
              : "operator";

      // Build the patch from ONLY the allowed fields that are present.
      const patch: Partial<
        Pick<
          NewBacklogItem,
          | "to_agent"
          | "dispatch_body"
          | "risk_class"
          | "write_scope"
          | "dependencies"
          | "token_estimate"
          | "provider"
          | "runtime"
          | "value_score"
          | "priority"
        >
      > = {};
      const errors: string[] = [];
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
      const asStrOrNull = (v: unknown, f: string) => {
        if (v === null || typeof v === "string") return v as string | null;
        errors.push(`${f} must be a string or null`);
        return undefined;
      };
      const asNumOrNull = (v: unknown, f: string) => {
        if (v === null || (typeof v === "number" && Number.isFinite(v))) return v as number | null;
        errors.push(`${f} must be a number or null`);
        return undefined;
      };
      const asStrArr = (v: unknown, f: string) => {
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
        errors.push(`${f} must be an array of strings`);
        return undefined;
      };

      if (has("to_agent")) patch.to_agent = asStrOrNull(body.to_agent, "to_agent") ?? undefined;
      if (has("dispatch_body")) patch.dispatch_body = asStrOrNull(body.dispatch_body, "dispatch_body") ?? undefined;
      if (has("provider")) patch.provider = asStrOrNull(body.provider, "provider") ?? undefined;
      if (has("runtime")) patch.runtime = asStrOrNull(body.runtime, "runtime") ?? undefined;
      if (has("risk_class")) {
        const rc = body.risk_class;
        const allowed = ["routine", "build", "external", "destructive", "costly", "novel"];
        if (typeof rc === "string" && allowed.includes(rc)) patch.risk_class = rc as RiskClass;
        else errors.push(`risk_class must be one of ${allowed.join("|")}`);
      }
      if (has("write_scope")) patch.write_scope = asStrArr(body.write_scope, "write_scope");
      if (has("dependencies")) patch.dependencies = asStrArr(body.dependencies, "dependencies");
      if (has("token_estimate")) patch.token_estimate = asNumOrNull(body.token_estimate, "token_estimate");
      if (has("value_score")) patch.value_score = asNumOrNull(body.value_score, "value_score");
      if (has("priority")) {
        const p = body.priority;
        if (typeof p === "number" && Number.isFinite(p)) patch.priority = p;
        else errors.push("priority must be a number");
      }

      if (errors.length > 0) {
        return res.status(400).json({ ok: false, error: "invalid patch", details: errors });
      }

      const item = await updateBacklogFields(adapter, id, patch, { updated_by: actor });
      res.json({ ok: true, item, updated_by: actor });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Import the roadmap markdown into needs_review drafts (never ready).
  app.post("/orchestration/import-roadmap", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: string };
      if (!body.path) return res.status(400).json({ ok: false, error: "path required" });
      if (!fs.existsSync(body.path)) return res.status(404).json({ ok: false, error: "roadmap file not found" });
      const md = fs.readFileSync(body.path, "utf8");
      const parsed = parseRoadmapToBacklog(md, { team_id: teamId, source_ref: body.path });
      let inserted = 0;
      let skipped_existing = 0;
      for (const item of parsed.items) {
        const result = await insertBacklogItemIfAbsentByLogicalKey(adapter, item);
        if (result.inserted) inserted += 1;
        else skipped_existing += 1;
      }
      res.json({
        ok: true,
        inserted,
        skipped_existing,
        tracks: parsed.tracks,
        note: "imported as needs_review; promote to ready via the approval gate",
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Auto-flesh (daemon SELF-REFUEL) ──────────────────────────────────

  // POST /orchestration/flesh/run { limit?, dry_run?, item_ids?, actor? }
  // Run a flesh pass. dry_run=true mutates nothing (returns proposed patches).
  app.post("/orchestration/flesh/run", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        limit?: number;
        dry_run?: boolean;
        item_ids?: string[];
        actor?: string;
      };
      const summary = await runFleshPass(adapter, config, {
        teamId,
        dry_run: !!body.dry_run,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        item_ids: Array.isArray(body.item_ids) ? body.item_ids.map(String) : undefined,
        actor: typeof body.actor === "string" ? body.actor : "operator",
      });
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /orchestration/flesh/queue?state=unfleshed|failed|needs_chris_batch
  app.get("/orchestration/flesh/queue", async (req: Request, res: Response) => {
    try {
      const fleshState = typeof req.query.state === "string" ? req.query.state : undefined;
      const byStatus = await getFleshCounts(adapter, teamId);
      // needs_chris_batch is both a readiness_state and a flesh_status; list those rows.
      const items =
        fleshState === "needs_chris_batch"
          ? await listBacklogByState(adapter, { team_id: teamId, state: "needs_chris_batch" })
          : (await listBacklogByState(adapter, { team_id: teamId, state: "needs_review" })).filter((i) =>
              fleshState ? i.flesh_status === fleshState : true,
            );
      res.json({ ok: true, counts: byStatus, items });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /orchestration/flesh/held-confidence-review
  app.get("/orchestration/flesh/held-confidence-review", async (_req: Request, res: Response) => {
    try {
      const confidenceThreshold = AUTO_READY_CONFIDENCE_THRESHOLD;
      const items = await listHeldConfidenceReviewItems(adapter, {
        team_id: teamId,
        confidence_threshold: confidenceThreshold,
      });
      res.json({
        ok: true,
        confidence_threshold: confidenceThreshold,
        count: items.length,
        items,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /orchestration/flesh/log?item_id=...
  app.get("/orchestration/flesh/log", async (req: Request, res: Response) => {
    try {
      const item_id = typeof req.query.item_id === "string" ? req.query.item_id : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 100 : 100;
      const log = await listFleshLog(adapter, { team_id: teamId, item_id, limit });
      res.json({ ok: true, log });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /orchestration/flesh/:item_id/approve — apply the stored patch + READY.
  app.post("/orchestration/flesh/:item_id/approve", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.item_id);
      const body = (req.body ?? {}) as { approved_by?: string };
      const item = await getBacklogItem(adapter, id);
      if (!item) return res.status(404).json({ ok: false, error: "backlog item not found" });
      if (!item.flesh_patch) {
        return res.status(409).json({ ok: false, error: "no stored flesh patch to approve" });
      }
      const updated = await recordFleshOutcome(adapter, {
        item_id: id,
        flesh_status: "approved_ready",
        flesh_source: item.flesh_source ?? item.source_refs[0] ?? "roadmap",
        flesh_confidence: item.flesh_confidence ?? item.flesh_patch.confidence,
        patch: item.flesh_patch,
        promote: true,
        approved_by: typeof body.approved_by === "string" && body.approved_by ? body.approved_by : DEFAULT_ACTOR_ID,
      });
      await insertFleshLog(adapter, {
        item_id: id,
        team_id: teamId,
        actor_ref: typeof body.approved_by === "string" && body.approved_by ? body.approved_by : DEFAULT_ACTOR_ID,
        source_ref: item.flesh_source ?? null,
        input_hash: id,
        decision: "approved_by_chris",
        reason: "manual approval of needs_chris_batch item",
        proposed_patch: item.flesh_patch,
      });
      res.json({ ok: true, item: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /orchestration/flesh/:item_id/reject — leave un-dispatchable; mark failed.
  app.post("/orchestration/flesh/:item_id/reject", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.item_id);
      const body = (req.body ?? {}) as { reason?: string; actor?: string };
      const item = await getBacklogItem(adapter, id);
      if (!item) return res.status(404).json({ ok: false, error: "backlog item not found" });
      await setItemState(adapter, id, "needs_review");
      const updated = await recordFleshOutcome(adapter, {
        item_id: id,
        flesh_status: "failed",
        flesh_source: item.flesh_source ?? "roadmap",
        flesh_confidence: item.flesh_confidence ?? 0,
        flesh_error: typeof body.reason === "string" ? body.reason : "rejected by operator",
      });
      await insertFleshLog(adapter, {
        item_id: id,
        team_id: teamId,
        actor_ref: typeof body.actor === "string" && body.actor ? body.actor : DEFAULT_ACTOR_ID,
        source_ref: item.flesh_source ?? null,
        input_hash: id,
        decision: "rejected",
        reason: typeof body.reason === "string" ? body.reason : "rejected by operator",
      });
      res.json({ ok: true, item: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/orchestration/decisions", async (req: Request, res: Response) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 100 : 100;
      const decisions = await listRecentDecisions(adapter, { team_id: teamId, limit });
      res.json({ ok: true, decisions });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
