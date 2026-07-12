// POST /orchestration/backlog — advisory guard for accidental pool bypass.
//
// Named pool members plus bare repo_root write_scope serialize pool-eligible
// work onto one lane. The endpoint warns, but does not block, so authors can
// still pin a named agent when the dispatch body gives an explicit reason.

import express, { type Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";

let app: Express;
let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  app = express();
  app.use(express.json());
  mountContinuousOrchestrationRoutes(app, {
    daemon: {} as unknown as ContinuousOrchestrationDaemon,
    adapter,
    config: defaultConfig(),
    teamId: "default",
  });
});

async function postBacklog(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}/orchestration/backlog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        server.close(() => resolve({ status: r.status, body: parsed }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

describe("POST /orchestration/backlog named pool member bare repo warning", () => {
  it("warns when a backend pool member is pinned to the bare backend repo_root", async () => {
    const r = await postBacklog({
      title: "Scheduler lint pass",
      track: "T-ORCH",
      to_agent: "roger",
      dispatch_body: "Add an orchestration lint pass.",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents"],
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.item.item_id).toBeTruthy();
    expect(r.body.warnings).toEqual([
      expect.objectContaining({
        code: "named_pool_agent_bare_repo_write_scope",
        details: expect.objectContaining({
          to_agent: "roger",
          pool_id: "backend",
          repo_root: "/Users/kilgore/Dropbox/Code/cane/id-agents",
          suggested_to_agent: "pool:backend",
        }),
      }),
    ]);
  });

  it("does not warn when a named pool member includes an explicit reason keyword", async () => {
    const r = await postBacklog({
      title: "Architecture-sensitive scheduler fix",
      track: "T-ORCH",
      to_agent: "roger",
      dispatch_body: "Architecture reason: keep this with Roger because it touches scheduler policy.",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents"],
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.warnings).toEqual([]);
  });

  it("does not warn for isolated worktree scopes", async () => {
    const r = await postBacklog({
      title: "Worktree-scoped backend build",
      track: "T-ORCH",
      to_agent: "substrate-api-codex",
      dispatch_body: "Run an isolated backend build.",
      write_scope: ["/Users/kilgore/Dropbox/Code/cane/id-agents/.worktrees/build-abc"],
    });

    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
  });

  it("still warns when a bare repo scope is mixed with a worktree scope", async () => {
    const r = await postBacklog({
      title: "Mixed-scope backend build",
      track: "T-ORCH",
      to_agent: "substrate-api-codex",
      dispatch_body: "Run a backend build.",
      write_scope: [
        "/Users/kilgore/Dropbox/Code/cane/id-agents",
        "/Users/kilgore/Dropbox/Code/cane/id-agents/.worktrees/build-abc",
      ],
    });

    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([
      expect.objectContaining({
        code: "named_pool_agent_bare_repo_write_scope",
        details: expect.objectContaining({
          to_agent: "substrate-api-codex",
          pool_id: "backend",
        }),
      }),
    ]);
  });
});
