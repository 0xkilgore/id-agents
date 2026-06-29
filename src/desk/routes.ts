// Kapelle Desk — Express routes.
//
// GET  /desk/tray     — desk.tray.v1 envelope (artifacts + needs-you federation)
// GET  /desk/entries  — read-model.v1 substrate query (I-1; flag stays OFF for cutover)
// POST /desk/items    — idempotent DeskItem upsert

import { homedir } from "node:os";
import path from "node:path";
import type { Application, Request, Response } from "express";
import { listBacklogByState } from "../continuous-orchestration/storage.js";
import type { DbAdapter } from "../db/db-adapter.js";
import { listDecisions } from "../decisions/storage.js";
import { listInboxItems } from "../outputs/storage.js";
import { computeDeskDocModelParity } from "./doc-model-parity.js";
import { buildDeskEntriesEnvelope, deskRowToEntry } from "./entry-projection.js";
import { buildDeskNeedsMeEnvelope, listUnreadArtifactComments } from "./needs-me.js";
import { buildDeskTrayEnvelope, deskRowToTrayItem } from "./projection.js";
import { computeDeskParity } from "./parity.js";
import { getDeskItemById, listDeskItems, listDeskOperations, upsertDeskItem } from "./storage.js";
import type { DeskItemKind, DeskTrayZone, UpsertDeskItemInput } from "./types.js";

const VALID_KINDS = new Set<DeskItemKind>([
  "artifact",
  "tickler",
  "stale",
  "dispatch_reply",
  "note",
  "decision",
]);

const VALID_ZONES = new Set<DeskTrayZone>(["needs_you", "shipped"]);

export function defaultDeskMarkdownPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DESK_MARKDOWN_SOURCE_PATH ||
    path.join(homedir(), "Dropbox", "Obsidian", "Desk.md")
  );
}

export interface MountDeskRoutesOptions {
  now?: () => Date;
  deskMarkdownPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function mountDeskRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountDeskRoutesOptions = {},
): void {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const deskMarkdownPath = opts.deskMarkdownPath ?? defaultDeskMarkdownPath(env);

  app.get("/desk/tray", async (_req: Request, res: Response) => {
    try {
      const generatedAt = now().toISOString();
      const [deskRows, artifactInbox, decisionRows] = await Promise.all([
        listDeskItems(adapter, { desk_class: "tray" }),
        listInboxItems(adapter, { includeNeverViewed: true }, 20, 0),
        listDecisions(adapter, { status: "open", limit: 8 }),
      ]);

      const parity = computeDeskParity(deskRows, deskMarkdownPath, generatedAt);
      const response = buildDeskTrayEnvelope({
        generatedAt,
        deskRows,
        artifactInboxRows: artifactInbox,
        openDecisions: decisionRows,
        parityStatus: parity.status,
        env,
      });
      res.json(response);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/desk/needs-me", async (req: Request, res: Response) => {
    try {
      const generatedAt = now().toISOString();
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
      const teamId = typeof req.query.team_id === "string" && req.query.team_id.trim()
        ? req.query.team_id.trim()
        : "default";
      const perSourceLimit = Math.min(limit, 100);
      const [approvals, artifactReview, unreadComments, needsChris] = await Promise.all([
        listDecisions(adapter, { status: "open", limit: perSourceLimit }),
        listInboxItems(adapter, { includeNeverViewed: true }, perSourceLimit, 0),
        listUnreadArtifactComments(adapter, { actor: "user:chris", limit: perSourceLimit }),
        listBacklogByState(adapter, { team_id: teamId, state: "needs_chris_batch", limit: perSourceLimit }),
      ]);
      res.json(buildDeskNeedsMeEnvelope({
        generatedAt,
        teamId,
        limit,
        approvals,
        artifactReview,
        unreadComments,
        needsChris,
      }));
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /desk/entries — I-1 substrate query (read-model.v1). Available while
  // DESK_USE_DOCUMENT_MODEL stays OFF; parity vs GET /desk/tray must be green
  // before the operator cutover flips.
  app.get("/desk/entries", async (req: Request, res: Response) => {
    try {
      const generatedAt = now().toISOString();
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const rows = await listDeskItems(adapter, {
        desk_class: "tray",
        tray_state: "on_desk",
        limit: 500,
      });
      const opsByItemId = new Map<string, Awaited<ReturnType<typeof listDeskOperations>>>();
      await Promise.all(
        rows.map(async (row) => {
          opsByItemId.set(row.desk_item_id, await listDeskOperations(adapter, row.desk_item_id));
        }),
      );
      const substrateEntries = rows.map((row) =>
        deskRowToEntry(row, opsByItemId.get(row.desk_item_id) ?? []),
      );
      const currentTrayItems = rows.map(deskRowToTrayItem);
      const docModelParity = computeDeskDocModelParity(substrateEntries, currentTrayItems, generatedAt);
      const envelope = buildDeskEntriesEnvelope(rows, opsByItemId, { limit, offset }, docModelParity.status);
      res.json(envelope);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /desk/entries/:ref — the single doc-model DeskEntry (with DV2
  // provenance) for one desk item, symmetric with artifacts/tasks per-entry reads.
  app.get("/desk/entries/:ref", async (req: Request<{ ref: string }>, res: Response) => {
    try {
      const row = await getDeskItemById(adapter, req.params.ref);
      if (!row) {
        res.status(404).json({ error: `Desk item "${req.params.ref}" not found` });
        return;
      }
      const ops = await listDeskOperations(adapter, row.desk_item_id);
      res.json({ entry: deskRowToEntry(row, ops) });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/desk/items", async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<UpsertDeskItemInput> | undefined;
      if (!body?.label?.trim()) {
        res.status(400).json({ ok: false, error: "label_required" });
        return;
      }
      if (!body.kind || !VALID_KINDS.has(body.kind)) {
        res.status(400).json({
          ok: false,
          error: "invalid_kind",
          message: "kind must be one of: artifact, tickler, stale, dispatch_reply, note, decision",
        });
        return;
      }
      if (body.tray_zone && !VALID_ZONES.has(body.tray_zone)) {
        res.status(400).json({ ok: false, error: "invalid_tray_zone" });
        return;
      }
      const actor =
        typeof (body as { added_by?: string }).added_by === "string"
          ? (body as { added_by: string }).added_by
          : "system";
      const result = await upsertDeskItem(adapter, body as UpsertDeskItemInput, actor);
      res.json({ ok: true, schema_version: "desk.item.v1", ...result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
