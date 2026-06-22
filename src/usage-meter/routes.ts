// Usage Meter — Express routes (GET /usage).
// Read-only; mounts cleanly next to /monitor/* and /metrics/* on the
// manager management app.

import type { Application, Request, Response } from "express";
import type { UsageMeterService } from "./service.js";
import type { DbAdapter } from "../db/db-adapter.js";
import { listRecentAgentUsageEvents } from "./storage.js";
import { loadDispatchAttributions } from "./dispatch-attribution.js";
import { ingestTranscripts } from "./ingest-transcripts.js";
import {
  buildDailyUsageReport,
  renderDailyUsageReportMarkdown,
  DEFAULT_REPORT_TZ,
  type MeterSnapshot,
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
      const topDimensions = clampInt(req.query.top_dimensions, 10, 1, 50);
      const events = await listRecentAgentUsageEvents(opts.adapter, { since_ms: sinceMs, limit: 200_000 });

      // Project/task attribution: join the events' dispatch_ids → dispatch
      // subjects (project parsed from `[project: X]`; task = the subject).
      const dispatchIds = events
        .map((e) => e.dispatch_id)
        .filter((d): d is string => typeof d === "string" && d.length > 0);
      const attributions = await loadDispatchAttributions(opts.adapter, dispatchIds);
      const dispatchMeta = (id: string | null | undefined) =>
        id ? attributions.get(id) : undefined;

      // Live rate-limit windows, read off the same usage-meter-v2 the gate uses.
      const meter = await readMeterSnapshot(opts.service);

      const report = buildDailyUsageReport({
        events,
        date,
        tz,
        nowMs,
        trendDays,
        topBurners,
        topDimensions,
        dispatchMeta,
        meter,
      });
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

  // ── Usage CAPTURE: ingest Claude Code transcripts into agent_usage_event ──
  // Without this the meter rendered but recorded nothing (every day = 0). The
  // ingest walks ~/.claude/projects, parses real token counts, attributes per
  // agent, and upserts idempotent events. Wired here (not in the manager) so
  // the manager wiring stays untouched; runs on demand + on a best-effort timer.
  if (opts.adapter) {
    const adapter = opts.adapter;

    // POST /usage/ingest?lookback_days=9 — capture now, return counts.
    app.post("/usage/ingest", async (req: Request, res: Response) => {
      try {
        const lookbackDays = clampInt(req.query.lookback_days, 9, 1, 365);
        const result = await ingestTranscripts(adapter, { lookbackDays });
        await opts.service.refreshRollups();
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Best-effort background capture: shortly after mount, then every 10 min.
    const runIngest = async () => {
      try {
        const r = await ingestTranscripts(adapter, {});
        await opts.service.refreshRollups();
        if (r.inserted > 0) {
          console.log(
            `[usage-meter] transcript ingest: +${r.inserted} events from ${r.files_scanned} files ` +
              `(${r.skipped_idempotent} already recorded)`,
          );
        }
      } catch (err) {
        console.warn(
          `[usage-meter] transcript ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    setTimeout(() => void runIngest(), 5_000).unref?.();
    const timer = setInterval(() => void runIngest(), 10 * 60_000);
    if (typeof timer.unref === "function") timer.unref();
  }
}

/**
 * Read the live meter's daily/weekly windows (% used + reset timestamp) off
 * usage-meter-v2 so the report and the rate-limit gate speak the same numbers.
 * Returns null on any meter error — the report still renders without it.
 */
async function readMeterSnapshot(service: UsageMeterService): Promise<MeterSnapshot | null> {
  try {
    const r = await service.buildReport();
    return {
      daily: {
        percent: r.gate?.daily_percent ?? 0,
        reset_at: r.windows?.daily?.reset_at ?? null,
        time_until_reset_seconds: r.windows?.daily?.time_until_reset_seconds ?? null,
      },
      weekly: {
        percent: r.gate?.weekly_percent ?? 0,
        reset_at: r.windows?.weekly?.reset_at ?? null,
        time_until_reset_seconds: r.windows?.weekly?.time_until_reset_seconds ?? null,
      },
    };
  } catch {
    return null;
  }
}

function clampInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
