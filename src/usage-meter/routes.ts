// Usage Meter — Express routes (GET /usage).
// Read-only; mounts cleanly next to /monitor/* and /metrics/* on the
// manager management app.

import type { Application, Request, Response } from "express";
import type { UsageMeterService } from "./service.js";
import type { DbAdapter } from "../db/db-adapter.js";
import { listRecentAgentUsageEvents } from "./storage.js";
import {
  buildDailyUsageReport,
  renderDailyUsageReportMarkdown,
  DEFAULT_REPORT_TZ,
} from "./daily-report.js";

export interface UsageMeterRouteOptions {
  service: UsageMeterService;
  /** Needed for GET /usage/daily-report (reads agent_usage_event). */
  adapter?: DbAdapter;
}

/**
 * Mount usage-meter routes. Pass an Express app (the manager's
 * managementApp) and a configured UsageMeterService instance.
 */
export function mountUsageMeterRoutes(app: Application, opts: UsageMeterRouteOptions): void {
  app.get("/usage", async (_req: Request, res: Response) => {
    try {
      const report = await opts.service.buildReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({
        schema_version: "usage-meter-v2",
        error: err instanceof Error ? err.message : String(err),
        source: "manager-usage-meter",
      });
    }
  });

  // GET /usage/daily-report?date=YYYY-MM-DD&trend_days=7&top=5&tz=&format=md
  // Daily token-usage report: per-provider / per-agent / total + rolling trend +
  // biggest burners. JSON by default; `format=md` returns the Desk/artifact body.
  app.get("/usage/daily-report", async (req: Request, res: Response) => {
    try {
      if (!opts.adapter) {
        return res.status(503).json({ ok: false, error: "usage_db_unavailable" });
      }
      const tz = typeof req.query.tz === "string" && req.query.tz ? req.query.tz : DEFAULT_REPORT_TZ;
      const date = typeof req.query.date === "string" && req.query.date ? req.query.date : undefined;
      const trendDays = clampInt(req.query.trend_days, 7, 1, 90);
      const topBurners = clampInt(req.query.top, 5, 1, 50);
      const nowMs = Date.now();
      // Fetch enough history to cover the trend window (+ a day of slack).
      const sinceMs = nowMs - (trendDays + 2) * 24 * 60 * 60 * 1000;
      const events = await listRecentAgentUsageEvents(opts.adapter, { since_ms: sinceMs, limit: 200_000 });
      const report = buildDailyUsageReport({ events, date, tz, nowMs, trendDays, topBurners });
      if (req.query.format === "md") {
        res.type("text/markdown").send(renderDailyUsageReportMarkdown(report));
        return;
      }
      res.json({ ok: true, ...report });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Optional helper: GET /usage/gate returns just the gate snapshot.
  app.get("/usage/gate", async (_req: Request, res: Response) => {
    try {
      const snap = await opts.service.getSnapshotForScheduler();
      res.json(snap);
    } catch (err) {
      res.status(500).json({
        status: "degraded",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function clampInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
