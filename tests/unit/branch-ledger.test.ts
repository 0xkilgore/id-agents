import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  ingestBranchLedgerScannerJson,
  listBranchLedgerRows,
  migrateBranchLedgerTables,
} from "../../src/branch-ledger/storage.js";
import { mountBranchLedgerRoutes } from "../../src/branch-ledger/routes.js";

async function bootStorage() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateBranchLedgerTables(adapter);
  return adapter;
}

async function bootApp() {
  const adapter = new SqliteAdapter(":memory:");
  const app = express();
  app.use(express.json());
  await mountBranchLedgerRoutes(app, adapter, {
    now: () => new Date("2026-07-08T12:00:00.000Z"),
    isAdminRequest: () => true,
  });
  return { app, adapter };
}

function request(app: Express) {
  return {
    async get(path: string): Promise<{ status: number; body: any }> {
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
    },
    async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") return reject(new Error("no address"));
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const parsed = await r.json();
            server.close(() => resolve({ status: r.status, body: parsed }));
          } catch (err) {
            server.close(() => reject(err));
          }
        });
      });
    },
  };
}

describe("Branch Ledger ingestion/read-model v0", () => {
  it("computes stable repo:branch:class_code dedupe keys and repeated scans update rows", async () => {
    const adapter = await bootStorage();

    const first = await ingestBranchLedgerScannerJson(adapter, {
      run_id: "run-1",
      incidents: [{
        repo: "id-agents",
        branch: "feature/x",
        class_code: "stale_feature_branch",
        head_sha: "aaa",
        action_class: "needs_owner",
        owner_lane: "substrate-api-codex",
        last_commit_at: "2026-06-01T00:00:00.000Z",
        last_seen_at: "2026-07-08T10:00:00.000Z",
        evidence: [{ kind: "git", detail: "first" }],
      }],
    }, { now: "2026-07-08T10:00:00.000Z" });

    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.rows[0].dedupe_key).toBe("id-agents:feature/x:stale_feature_branch");

    const second = await ingestBranchLedgerScannerJson(adapter, {
      run_id: "run-2",
      incidents: [{
        repo: "id-agents",
        branch: "feature/x",
        class_code: "stale_feature_branch",
        head_sha: "bbb",
        ahead: 3,
        action_class: "needs_owner",
        owner_lane: "substrate-api-codex",
        recommended_action: "refresh branch from main",
        last_commit_at: "2026-06-01T00:00:00.000Z",
        last_seen_at: "2026-07-08T11:00:00.000Z",
      }],
    }, { now: "2026-07-08T11:00:00.000Z" });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await listBranchLedgerRows(adapter, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: "id-agents:feature/x:stale_feature_branch",
      head_sha: "bbb",
      ahead: 3,
      last_hygiene_run_id: "run-2",
      recommended_action: "refresh branch from main",
    });
  });

  it("filters by repo, action class, owner lane, stale age, and needs-Chris", async () => {
    const adapter = await bootStorage();
    await ingestBranchLedgerScannerJson(adapter, {
      incidents: [
        {
          repo: "id-agents",
          branch: "stale-owner",
          class_code: "stale_feature_branch",
          action_class: "needs_owner",
          owner_lane: "substrate-api-codex",
          last_commit_at: "2026-06-01T00:00:00.000Z",
        },
        {
          repo: "kapelle-site",
          branch: "decision",
          class_code: "unknown_branch_owner",
          action_class: "needs_chris",
          owner_lane: "chris",
          last_commit_at: "2026-07-07T00:00:00.000Z",
        },
        {
          repo: "id-agents",
          branch: "safe",
          class_code: "branch_held_by_worktree",
          action_class: "safe_auto_action",
          owner_lane: "substrate-api-codex",
          last_commit_at: "2026-07-07T00:00:00.000Z",
        },
      ],
    }, { now: "2026-07-08T12:00:00.000Z" });

    expect((await listBranchLedgerRows(adapter, { repo: "id-agents" })).map((r) => r.branch).sort()).toEqual(["safe", "stale-owner"]);
    expect((await listBranchLedgerRows(adapter, { action_class: "needs_chris" })).map((r) => r.branch)).toEqual(["decision"]);
    expect((await listBranchLedgerRows(adapter, { owner_lane: "substrate-api-codex" })).map((r) => r.branch).sort()).toEqual(["safe", "stale-owner"]);
    expect((await listBranchLedgerRows(adapter, { needs_chris: true })).map((r) => r.branch)).toEqual(["decision"]);
    expect((await listBranchLedgerRows(adapter, {
      stale_age_days: 30,
      now: "2026-07-08T12:00:00.000Z",
    })).map((r) => r.branch)).toEqual(["stale-owner"]);
  });

  it("exposes ingestion and filtered read routes", async () => {
    const { app } = await bootApp();
    const api = request(app);

    const post = await api.post("/branch-ledger/ingest", {
      run_id: "run-route",
      incidents: [{
        repo: "id-agents",
        branch: "route",
        class_code: "dirty_primary_checkout",
        action_class: "needs_chris",
      }],
    });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({
      ok: true,
      schema_version: "branch-ledger.ingest.v1",
      inserted: 1,
      updated: 0,
      dedupe_keys: ["id-agents:route:dirty_primary_checkout"],
    });

    const get = await api.get("/worktree-hygiene/branch-ledger?repo=id-agents&needs_chris=true");
    expect(get.status).toBe(200);
    expect(get.body.schema_version).toBe("branch-ledger.v1");
    expect(get.body.items).toHaveLength(1);
    expect(get.body.items[0]).toMatchObject({
      repo: "id-agents",
      branch: "route",
      dedupe_key: "id-agents:route:dirty_primary_checkout",
    });
  });
});
