import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { mountWorktreeHygieneRoutes } from "../../src/worktree-hygiene/routes.js";
import { ingestBranchLedgerScannerJson } from "../../src/branch-ledger/storage.js";
import type { DirtyRootRecord } from "../../src/workspaces/monitor.js";

describe("GET /worktree-hygiene", () => {
  it("returns the live deterministic contract without falling back to fixtures", async () => {
    const adapter = new SqliteAdapter(":memory:");
    setupDispatchTable(adapter);
    const app = express();
    app.use(express.json());
    await mountWorktreeHygieneRoutes(app, adapter, {
      now: () => new Date("2026-07-12T14:00:00.000Z"),
      sampleRoots: () => [
        root({
          repo_name: "kapelle-site",
          root: "/repo/kapelle-site",
          branch: "main",
          head_sha: "kapelle-head",
          origin_main_sha: "kapelle-promoted",
        }),
      ],
      buildStatus: () => ({
        build_sha: "old-running",
        build_time: null,
        source_branch_sha: "kapelle-promoted",
        source_branch_name: "main",
        local_main_sha: "kapelle-promoted",
        origin_main_sha: "kapelle-promoted",
        behind_origin: true,
        freshness: {
          classification: "server_not_rebuilt",
          running_manager_build_sha: "old-running",
          source_branch_sha: "kapelle-promoted",
          source_branch_name: "main",
          promoted_main_sha: "kapelle-promoted",
          behind_promoted_main: true,
          source_differs_from_promoted_main: false,
          message: "running build is stale",
        },
        source: "build_stamp",
      }),
      originMainCommitsToday: () => [{ sha: "kapelle-promoted", subject: "Release visibility", repo: "kapelle-site" }],
    });

    await ingestBranchLedgerScannerJson(adapter, {
      incidents: [{
        repo: "kapelle-site",
        branch: "feature/live",
        class_code: "stale_feature_branch",
        action_class: "needs_owner",
        ahead: 2,
        behind: 3,
      }],
    }, { now: "2026-07-12T14:00:00.000Z" });
    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, query_id, to_agent, status, completed_at, updated_at, promotion_result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "phid:disp-ui",
        "query-ui",
        "substrate-api-codex",
        "done",
        "2026-07-12T13:00:00.000Z",
        "2026-07-12T13:00:00.000Z",
        JSON.stringify({
          completed: true,
          repos: [{
            path: "/repo/kapelle-site",
            source_branch: "feature/live",
            base: "main",
            promoted_sha: "kapelle-promoted",
            remote_main_sha: "kapelle-promoted",
            pushed: true,
            verified: true,
          }],
        }),
      ],
    );

    const res = await request(app, "/worktree-hygiene");
    await adapter.close();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      schema_version: "worktree-hygiene.v1",
      generated_at: "2026-07-12T14:00:00.000Z",
      source: {
        projection: "worktree_hygiene",
        source_type: "live_git_and_manager_read_model",
        freshness: "live",
      },
    });
    expect(res.body.protected_repos[0]).toMatchObject({
      repo: "kapelle-site",
      root: "/repo/kapelle-site",
      branch: "main",
      head_sha: "kapelle-head",
      origin_main_sha: "kapelle-promoted",
    });
    expect(res.body.worktree_summary.stale_diverged).toBe(1);
    expect(res.body.commit_movement.origin_main_today_count).toBe(1);
    expect(res.body.commit_movement.active_branch_ahead_counts).toEqual([
      { repo: "kapelle-site", branch: "feature/live", ahead: 2, source: "branch_ledger" },
    ]);
    expect(res.body.accepted_ui_awaiting_release.count).toBe(1);
    expect(res.body.next_action).toBe("fresh_branch");
  });
});

function setupDispatchTable(adapter: SqliteAdapter): void {
  adapter.exec(`
    CREATE TABLE dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      query_id TEXT,
      to_agent TEXT,
      status TEXT,
      completed_at TEXT,
      updated_at TEXT,
      promotion_result_json TEXT
    );
  `);
}

function request(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await r.json();
        server.close(() => resolve({ status: r.status, body }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

function root(overrides: Partial<DirtyRootRecord>): DirtyRootRecord {
  return {
    root: "/repo/default",
    repo_name: "repo",
    branch: "main",
    intended_branch: "main",
    head_sha: "head",
    origin_main_sha: "head",
    off_canonical_branch: false,
    remote: "origin",
    base: "main",
    ahead: 0,
    behind: 0,
    dirty_count: 0,
    dirty_tracked_count: 0,
    dirty_untracked_count: 0,
    status_short: "",
    last_lease_id: null,
    last_dispatch_id: null,
    severity: "info",
    observed_at: "2026-07-12T14:00:00.000Z",
    ...overrides,
  };
}
