import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TasksRepository } from "../db/db-service.js";
import { listReviewNextSourceRows } from "../review-next/storage.js";
import type { ReviewNextAction } from "../review-next/types.js";
import { buildDailyDeskResponse } from "./projection.js";
import { listFollowThroughSources, listNeedsResponseSources } from "./storage.js";
import type { DailyDeskSourceSet } from "./types.js";

export interface DailyDeskRouteOptions {
  tasks: TasksRepository;
  resolveTeamId: (req: Request) => Promise<string>;
  now?: () => Date;
  supportedReviewNextActions?: ReadonlySet<ReviewNextAction>;
  loadSources?: (teamId: string) => Promise<DailyDeskSourceSet>;
}

export function mountDailyDeskRoutes(app: Application, adapter: DbAdapter, options: DailyDeskRouteOptions): void {
  app.get("/daily-desk", async (req: Request, res: Response) => {
    const startedAt = performance.now();
    try {
      const today = parseToday(req.query.today);
      if (req.query.today !== undefined && !today) {
        res.status(400).json({ ok: false, schema_version: "daily-desk.v1", error: "today must be YYYY-MM-DD" });
        return;
      }
      const teamId = await options.resolveTeamId(req);
      const sources = options.loadSources
        ? await options.loadSources(teamId)
        : await loadDailyDeskSources(adapter, options.tasks, teamId);
      const body = buildDailyDeskResponse(sources, {
        now: options.now?.(),
        today: today ?? undefined,
        supportedReviewNextActions: options.supportedReviewNextActions,
      });
      const durationMs = performance.now() - startedAt;
      res.setHeader("server-timing", `daily-desk-projection;dur=${durationMs.toFixed(1)}`);
      res.setHeader("x-daily-desk-payload-bytes", String(body.payload_bytes));
      res.json(body);
    } catch (error) {
      res.status(500).json({
        ok: false,
        schema_version: "daily-desk.v1",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function loadDailyDeskSources(
  adapter: DbAdapter,
  tasks: TasksRepository,
  teamId: string,
): Promise<DailyDeskSourceSet> {
  const [today, reviewNext, needsResponse, followThrough] = await Promise.all([
    tasks.list({ teamId, limit: 500, offset: 0 }),
    listReviewNextSourceRows(adapter),
    listNeedsResponseSources(adapter, teamId),
    listFollowThroughSources(adapter, teamId),
  ]);
  return {
    today,
    review_next_source: reviewNext,
    needs_response: needsResponse,
    follow_through: followThrough,
  };
}

function parseToday(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
