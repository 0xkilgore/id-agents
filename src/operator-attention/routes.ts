import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TasksRepository } from "../db/db-service.js";
import { loadDailyDeskSources } from "../daily-desk/routes.js";
import { buildOperatorAttention, OperatorAttentionUnavailableError } from "./projection.js";
import type { OperatorAttentionSourceSet } from "./types.js";

export interface OperatorAttentionRouteOptions {
  tasks: TasksRepository;
  resolveTeamId: (req: Request) => Promise<string>;
  now?: () => Date;
  loadSources?: (teamId: string) => Promise<OperatorAttentionSourceSet>;
}

export function mountOperatorAttentionRoutes(app: Application, adapter: DbAdapter, options: OperatorAttentionRouteOptions): void {
  const project = async (req: Request) => {
    const teamId = await options.resolveTeamId(req);
    const source = options.loadSources
      ? await options.loadSources(teamId)
      : { daily_desk: await loadDailyDeskSources(adapter, options.tasks, teamId) };
    return buildOperatorAttention(source, { evaluatedAt: options.now?.() });
  };

  app.get("/operator-attention", async (req: Request, res: Response) => {
    const startedAt = performance.now();
    try {
      const { response } = await project(req);
      const durationMs = performance.now() - startedAt;
      res.setHeader("server-timing", `operator-attention-db-serialize;dur=${durationMs.toFixed(1)}`);
      res.setHeader("x-operator-attention-payload-bytes", String(response.payload_bytes));
      res.json(response);
    } catch (error) {
      sendProjectionError(res, error);
    }
  });

  app.get("/operator-attention/suppressions", async (req: Request, res: Response) => {
    try {
      const ref = typeof req.query.ref === "string" ? req.query.ref : "";
      if (!ref) {
        res.status(400).json({ ok: false, schema_version: "operator-attention.v1", error: "ref is required" });
        return;
      }
      const { suppressions } = await project(req);
      const match = suppressions.find((row) => row.ref === ref);
      res.status(match ? 200 : 404).json(match
        ? { ok: true, schema_version: "operator-attention.v1", suppression: match }
        : { ok: false, schema_version: "operator-attention.v1", error: "suppression_not_found", ref });
    } catch (error) {
      sendProjectionError(res, error);
    }
  });
}

function sendProjectionError(res: Response, error: unknown): void {
  if (error instanceof OperatorAttentionUnavailableError) {
    res.status(error.status).json({
      ok: false,
      schema_version: "operator-attention.v1",
      error: { code: error.code, message: error.message },
    });
    return;
  }
  res.status(500).json({
    ok: false,
    schema_version: "operator-attention.v1",
    error: error instanceof Error ? error.message : String(error),
  });
}
