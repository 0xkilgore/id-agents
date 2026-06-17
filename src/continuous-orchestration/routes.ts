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
  insertBacklogItem,
  listBacklogByState,
  listRecentDecisions,
  promoteToReady,
  updateBacklogFields,
  type NewBacklogItem,
} from "./storage.js";
import { parseRoadmapToBacklog } from "./roadmap-import.js";

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
      const [ready, needsReview, inFlight] = await Promise.all([
        listBacklogByState(adapter, { team_id: teamId, state: "ready" }),
        listBacklogByState(adapter, { team_id: teamId, state: "needs_review" }),
        listBacklogByState(adapter, { team_id: teamId, state: "in_flight" }),
      ]);
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
        counts: { ready: ready.length, needs_review: needsReview.length, in_flight: inFlight.length },
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
