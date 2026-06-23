// Continuous Orchestration — Express routes (read-only status + steering).
//
// Mounts under the manager management app next to /usage. Provides the kill
// switch / mode controls, the manual (dry-run) tick trigger, the backlog +
// approval-gate endpoints, and the decision-log audit feed.

import fs from "node:fs";
import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { ContinuousOrchestrationDaemon } from "./daemon.js";
import type { ContinuousOrchestrationConfig } from "./config.js";
import type { OrchestrationMode, ReadinessState } from "./types.js";
import {
  countFleshLogSince,
  getBacklogItem,
  getFleshCounts,
  insertBacklogItem,
  insertFleshLog,
  listBacklogByState,
  listFleshLog,
  listRecentDecisions,
  promoteToReady,
  recordFleshOutcome,
  setItemState,
  updateBacklogFields,
  type NewBacklogItem,
} from "./storage.js";
import type { RiskClass } from "./types.js";
import { parseRoadmapToBacklog } from "./roadmap-import.js";
import { runFleshPass } from "./flesh-runner.js";

export interface OrchestrationRouteOptions {
  daemon: ContinuousOrchestrationDaemon;
  adapter: DbAdapter;
  config: ContinuousOrchestrationConfig;
  teamId?: string;
}

export function mountContinuousOrchestrationRoutes(app: Application, opts: OrchestrationRouteOptions): void {
  const teamId = opts.teamId ?? "default";
  const { daemon, adapter, config } = opts;

  app.get("/orchestration/status", async (_req: Request, res: Response) => {
    try {
      const state = await daemon.getState();
      const [ready, needsReview, inFlight, needsChrisBatch, fleshCounts] = await Promise.all([
        listBacklogByState(adapter, { team_id: teamId, state: "ready" }),
        listBacklogByState(adapter, { team_id: teamId, state: "needs_review" }),
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
          needs_review: needsReview.length,
          in_flight: inFlight.length,
          needs_chris_batch: needsChrisBatch.length,
          unfleshed: fleshCounts.unfleshed ?? 0,
          auto_fleshed_today: autoFleshedToday,
        },
        flesh: { enabled: config.auto_flesh_enabled, min_ready_fuel: config.min_ready_fuel, by_status: fleshCounts },
      });
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

  app.get("/orchestration/backlog", async (req: Request, res: Response) => {
    try {
      const state = typeof req.query.state === "string" ? (req.query.state as ReadinessState) : undefined;
      const items = await listBacklogByState(adapter, { team_id: teamId, state });
      res.json({ ok: true, items });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/orchestration/backlog", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as NewBacklogItem;
      if (!body.title) return res.status(400).json({ ok: false, error: "title required" });
      // New items NEVER land ready — only the approval gate can do that.
      const safe: NewBacklogItem = {
        ...body,
        team_id: teamId,
        readiness_state: body.readiness_state === "ready" ? "needs_review" : body.readiness_state ?? "draft",
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
      const approvedBy = typeof body.approved_by === "string" && body.approved_by ? body.approved_by : "chris";
      const patch = body.patch && typeof body.patch === "object" ? (body.patch as Partial<NewBacklogItem>) : undefined;
      if (patch) await updateBacklogFields(adapter, id, patch);
      const result = await promoteToReady(adapter, id, approvedBy);
      if (!result.ok) return res.status(409).json({ ok: false, error: result.reason });
      res.json({ ok: true, item: result.item });
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
      for (const item of parsed.items) {
        await insertBacklogItem(adapter, item);
        inserted += 1;
      }
      res.json({ ok: true, inserted, tracks: parsed.tracks, note: "imported as needs_review; promote to ready via the approval gate" });
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
        approved_by: typeof body.approved_by === "string" && body.approved_by ? body.approved_by : "chris",
      });
      await insertFleshLog(adapter, {
        item_id: id,
        team_id: teamId,
        actor_ref: typeof body.approved_by === "string" && body.approved_by ? body.approved_by : "chris",
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
        actor_ref: typeof body.actor === "string" && body.actor ? body.actor : "chris",
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
