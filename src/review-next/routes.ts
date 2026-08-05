import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { buildReviewNextResponse } from "./projection.js";
import { listReviewNextSourceRows } from "./storage.js";
import type { ReviewNextAction } from "./types.js";

export interface ReviewNextRouteOptions {
  now?: () => Date;
  supportedActions?: ReadonlySet<ReviewNextAction>;
}

export function mountReviewNextRoutes(app: Application, adapter: DbAdapter, options: ReviewNextRouteOptions = {}): void {
  app.get("/artifacts/review-next", async (_req: Request, res: Response) => {
    const startedAt = performance.now();
    try {
      const rows = await listReviewNextSourceRows(adapter);
      const body = buildReviewNextResponse(rows, {
        now: options.now?.(),
        supportedActions: options.supportedActions,
      });
      const durationMs = performance.now() - startedAt;
      res.setHeader("server-timing", `review-next-projection;dur=${durationMs.toFixed(1)}`);
      res.setHeader("x-review-next-payload-bytes", String(body.payload_bytes));
      res.json(body);
    } catch (error) {
      res.status(500).json({
        ok: false,
        schema_version: "review-next.v1",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
