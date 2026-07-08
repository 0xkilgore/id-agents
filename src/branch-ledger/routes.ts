import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  ingestBranchLedgerScannerJson,
  countBranchLedgerExceptions,
  listBranchLedgerRows,
  migrateBranchLedgerTables,
} from "./storage.js";

export interface MountBranchLedgerRoutesOptions {
  now?: () => Date;
  isAdminRequest?: (req: Request) => boolean;
}

export async function mountBranchLedgerRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountBranchLedgerRoutesOptions = {},
): Promise<void> {
  await migrateBranchLedgerTables(adapter);
  const now = opts.now ?? (() => new Date());
  const isAdminRequest = opts.isAdminRequest ?? (() => true);

  const ingest = async (req: Request, res: Response) => {
    try {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: "unauthorized", code: "unauthorized" });
      }
      const result = await ingestBranchLedgerScannerJson(adapter, req.body, {
        now: now().toISOString(),
      });
      return res.json({
        ok: true,
        schema_version: "branch-ledger.ingest.v1",
        inserted: result.inserted,
        updated: result.updated,
        count: result.rows.length,
        dedupe_keys: result.rows.map((r) => r.dedupe_key),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("branch_ledger_ingest_missing_") ? 400 : 500;
      return res.status(status).json({ ok: false, error: message, code: message });
    }
  };

  const read = async (req: Request, res: Response) => {
    try {
      const rows = await listBranchLedgerRows(adapter, {
        repo: queryString(req.query.repo),
        action_class: queryString(req.query.action_class),
        owner_lane: queryString(req.query.owner_lane) ?? queryString(req.query.owner),
        needs_chris: queryBoolean(req.query.needs_chris),
        stale_age_days: queryNumber(req.query.stale_age_days) ?? queryNumber(req.query.min_stale_age_days),
        limit: queryNumber(req.query.limit),
        now: now().toISOString(),
      });
      const exceptionCounts = await countBranchLedgerExceptions(adapter);
      return res.json({
        ok: true,
        schema_version: "branch-ledger.v1",
        generated_at: now().toISOString(),
        source: {
          system: "manager",
          projection: "branch_ledger",
          source_type: "worktree_hygiene_scanner_json",
          read_path: "substrate",
        },
        filters: {
          repo: queryString(req.query.repo),
          action_class: queryString(req.query.action_class),
          owner_lane: queryString(req.query.owner_lane) ?? queryString(req.query.owner),
          needs_chris: queryBoolean(req.query.needs_chris),
          stale_age_days: queryNumber(req.query.stale_age_days) ?? queryNumber(req.query.min_stale_age_days),
          limit: queryNumber(req.query.limit) ?? 100,
        },
        counts: { returned: rows.length, exceptions: exceptionCounts },
        items: rows,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  app.post("/branch-ledger/ingest", ingest);
  app.post("/worktree-hygiene/branch-ledger/ingest", ingest);
  app.get("/branch-ledger", read);
  app.get("/worktree-hygiene/branch-ledger", read);
}

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function queryNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function queryBoolean(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}
