import { execFileSync } from "node:child_process";
import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { MonitorFleetResponse } from "../monitor/types.js";
import { listBranchLedgerRows, migrateBranchLedgerTables } from "../branch-ledger/storage.js";
import { RepoRegistry } from "../workspaces/repo-registry.js";
import { sampleAll, type DirtyRootRecord } from "../workspaces/monitor.js";
import {
  buildWorktreeHygieneReadModel,
  type CompactCommit,
  type PromotionEvidence,
} from "./read-model.js";

export interface MountWorktreeHygieneRoutesOptions {
  now?: () => Date;
  registry?: RepoRegistry;
  sampleRoots?: () => DirtyRootRecord[];
  buildStatus?: () => MonitorFleetResponse["build"] | null;
  originMainCommitsToday?: (roots: DirtyRootRecord[], now: Date) => CompactCommit[];
}

export async function mountWorktreeHygieneRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: MountWorktreeHygieneRoutesOptions = {},
): Promise<void> {
  await migrateBranchLedgerTables(adapter);
  const now = opts.now ?? (() => new Date());

  app.get("/worktree-hygiene", async (_req: Request, res: Response) => {
    try {
      const generatedAt = now();
      const roots = opts.sampleRoots
        ? opts.sampleRoots()
        : sampleAll(opts.registry ?? RepoRegistry.load(), { now: () => generatedAt, fetch: false });
      const [ledgerRows, promotions] = await Promise.all([
        listBranchLedgerRows(adapter, { limit: 500, now: generatedAt.toISOString() }),
        queryPromotionEvidence(adapter),
      ]);
      const response = buildWorktreeHygieneReadModel({
        generated_at: generatedAt.toISOString(),
        protected_roots: roots,
        branch_ledger_rows: ledgerRows,
        promotions,
        build: opts.buildStatus?.() ?? null,
        origin_main_commits_today: opts.originMainCommitsToday
          ? opts.originMainCommitsToday(roots, generatedAt)
          : collectOriginMainCommitsToday(roots, generatedAt),
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
}

async function queryPromotionEvidence(adapter: DbAdapter): Promise<PromotionEvidence[]> {
  const { rows } = await adapter.query<{
    dispatch_phid: string | null;
    query_id: string | null;
    to_agent: string | null;
    completed_at: string | null;
    promotion_result_json: string | null;
  }>(
    `SELECT dispatch_phid, query_id, to_agent, completed_at, promotion_result_json
       FROM dispatch_scheduler_queue
      WHERE promotion_result_json IS NOT NULL
      ORDER BY completed_at DESC, updated_at DESC
      LIMIT 100`,
  );
  const out: PromotionEvidence[] = [];
  for (const row of rows) {
    const promotion = parseJson(row.promotion_result_json) as {
      completed?: boolean;
      repos?: Array<{
        path?: string;
        repo?: string;
        source_branch?: string;
        branch?: string;
        base?: string;
        promoted_sha?: string;
        remote_main_sha?: string;
        pushed?: boolean;
        verified?: boolean;
      }>;
    } | null;
    if (!promotion || !Array.isArray(promotion.repos)) continue;
    for (const repo of promotion.repos) {
      out.push({
        dispatch_id: row.dispatch_phid,
        query_id: row.query_id,
        agent: row.to_agent,
        completed_at: row.completed_at,
        repo: stringOrNull(repo.path) ?? stringOrNull(repo.repo),
        branch: stringOrNull(repo.source_branch) ?? stringOrNull(repo.branch),
        base: stringOrNull(repo.base),
        promoted_sha: stringOrNull(repo.promoted_sha),
        remote_main_sha: stringOrNull(repo.remote_main_sha),
        completed: typeof promotion.completed === "boolean" ? promotion.completed : null,
        pushed: typeof repo.pushed === "boolean" ? repo.pushed : null,
        verified: typeof repo.verified === "boolean" ? repo.verified : null,
      });
    }
  }
  return out;
}

function collectOriginMainCommitsToday(roots: DirtyRootRecord[], now: Date): CompactCommit[] {
  const since = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const bySha = new Map<string, CompactCommit>();
  for (const root of roots) {
    if (root.error) continue;
    const rows = git(root.root, [
      "log",
      "--max-count=20",
      "--format=%H%x09%ct%x09%s",
      "--since",
      since,
      `${root.remote}/${root.base}`,
    ]);
    for (const line of rows.split("\n")) {
      if (!line.trim()) continue;
      const [sha, ts, ...subjectParts] = line.split("\t");
      if (!sha || bySha.has(sha)) continue;
      const committedAt = Number.isFinite(Number(ts)) ? new Date(Number(ts) * 1000).toISOString() : null;
      bySha.set(sha, {
        sha,
        subject: subjectParts.join("\t").slice(0, 120),
        repo: root.repo_name,
        committed_at: committedAt,
      });
    }
  }
  return [...bySha.values()].sort((a, b) => (b.committed_at ?? "").localeCompare(a.committed_at ?? "") || a.sha.localeCompare(b.sha)).slice(0, 20);
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString();
  } catch {
    return "";
  }
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
