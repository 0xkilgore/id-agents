import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  parseAgentObligationLimit,
  parseAgentObligationStatus,
  readAgentObligations,
} from "./read-model.js";

export function mountAgentObligationsRoutes(
  app: Application,
  adapter: DbAdapter,
  getTeam: (req: Request) => Promise<{ id: string; name: string }>,
): void {
  app.get("/agent-obligations", async (req: Request, res: Response) => {
    try {
      const status = parseAgentObligationStatus(req.query.status);
      if (!status) {
        return res.status(400).json({
          ok: false,
          error: "status must be expected, done, late, failed, or all",
        });
      }
      const limit = parseAgentObligationLimit(req.query.limit);
      const agent = typeof req.query.agent === "string" ? req.query.agent : null;
      const now = typeof req.query.now === "string" && req.query.now.length > 0 ? req.query.now : undefined;
      const includeReports = req.query.include_reports === "false" ? false : undefined;
      const { id: teamId, name: teamName } = await getTeam(req);
      const envelope = await readAgentObligations(adapter, teamId, {
        limit,
        agent,
        status,
        now,
        includeReports,
      });
      return res.json({ ...envelope, team: teamName, limit, status });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
