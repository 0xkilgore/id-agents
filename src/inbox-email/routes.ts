import type { Application, Request } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TasksRepository } from "../db/db-service.js";
import type { EnqueueInputV2, EnqueueResult } from "../dispatch-scheduler/manager-integration.js";
import { ingestForwardedEmail } from "./intake.js";
import { listEmailAliases, upsertEmailAlias } from "./storage.js";

export interface InboxEmailRouteOptions {
  tasks?: TasksRepository;
  resolveTeamId: (req: Request) => Promise<string>;
  enqueueDispatch?: (input: EnqueueInputV2, opts?: { wake?: boolean }) => Promise<EnqueueResult>;
}

export function mountInboxEmailRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: InboxEmailRouteOptions,
): void {
  app.get("/inbox/email/addresses", async (req, res) => {
    try {
      const teamId = await opts.resolveTeamId(req);
      res.json({ ok: true, addresses: await listEmailAliases(adapter, teamId) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/inbox/email/addresses", async (req, res) => {
    try {
      const teamId = await opts.resolveTeamId(req);
      if (!req.body?.user_id || !req.body?.address) {
        res.status(400).json({ error: "Missing required fields: user_id, address" });
        return;
      }
      const alias = await upsertEmailAlias(adapter, {
        team_id: teamId,
        user_id: String(req.body.user_id),
        address: String(req.body.address),
        default_project: req.body.default_project ?? null,
        default_agent: req.body.default_agent ?? null,
      });
      res.status(201).json({ ok: true, alias });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/inbox/email/ingest", async (req, res) => {
    try {
      const teamId = await opts.resolveTeamId(req);
      if (!req.body?.to) {
        res.status(400).json({ error: "Missing required field: to" });
        return;
      }
      const result = await ingestForwardedEmail(adapter, {
        team_id: teamId,
        to: String(req.body.to),
        from: req.body.from ?? null,
        subject: req.body.subject ?? null,
        text: req.body.text ?? null,
        html: req.body.html ?? null,
        message_id: req.body.message_id ?? null,
        received_at: req.body.received_at ?? null,
      }, {
        tasks: opts.tasks,
        enqueueDispatch: opts.enqueueDispatch,
      });
      res.status(result.idempotent ? 200 : 201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("No inbound email alias") ? 404 : 400).json({ error: msg });
    }
  });
}
