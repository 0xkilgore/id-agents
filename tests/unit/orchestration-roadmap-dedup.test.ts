import express, { type Express } from "express";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { mountContinuousOrchestrationRoutes } from "../../src/continuous-orchestration/routes.js";
import {
  getBacklogItem,
  insertBacklogItem,
  listFleshCandidates,
  listBacklogByState,
  promoteToReady,
} from "../../src/continuous-orchestration/storage.js";
import { parseRoadmapToBacklog } from "../../src/continuous-orchestration/roadmap-import.js";
import { createContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/factory.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { ContinuousOrchestrationDaemon } from "../../src/continuous-orchestration/daemon.js";

let adapter: SqliteAdapter;
let app: Express;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "roadmap-dedup-"));
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

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        server.close(() => resolve({ status: r.status, body: JSON.parse(text) }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function roadmapFile(): string {
  const p = join(tmpDir, "roadmap.md");
  writeFileSync(
    p,
    [
      "| Sub-track | What | Status |",
      "|---|---|---|",
      "| **T-MODEL.1** - provider routing | route Codex Light provider fallback | NEEDS-CLARIFICATION |",
    ].join("\n"),
  );
  return p;
}

describe("roadmap logical dedup", () => {
  it("parses a stable logical_key for a roadmap row", () => {
    const a = parseRoadmapToBacklog(
      "| Sub-track | What |\n|---|---|\n| **T-MODEL.1** - provider routing | x |",
      { source_ref: "a.md" },
    );
    const b = parseRoadmapToBacklog(
      "| Sub-track | What |\n|---|---|\n| `T-MODEL.1` — provider routing | y |",
      { source_ref: "b.md" },
    );
    expect(a.items[0].logical_key).toBe("roadmap:t-model-1:provider-routing");
    expect(b.items[0].logical_key).toBe(a.items[0].logical_key);
  });

  it("does not insert duplicate backlog items when the same roadmap is imported repeatedly", async () => {
    const path = roadmapFile();
    const first = await call("POST", "/orchestration/import-roadmap", { path });
    const second = await call("POST", "/orchestration/import-roadmap", { path });

    expect(first.status).toBe(200);
    expect(first.body.inserted).toBe(1);
    expect(first.body.skipped_existing).toBe(0);
    expect(second.status).toBe(200);
    expect(second.body.inserted).toBe(0);
    expect(second.body.skipped_existing).toBe(1);

    const items = await listBacklogByState(adapter, { team_id: "default" });
    expect(items).toHaveLength(1);
    expect(items[0].readiness_state).toBe("needs_review");
  });

  it("recognizes already in-flight and done logical work during import", async () => {
    const parsed = parseRoadmapToBacklog(roadmapFileMarkdown(), { source_ref: "old.md" });
    const active = await insertBacklogItem(adapter, {
      ...parsed.items[0],
      readiness_state: "in_flight",
      last_dispatch_phid: undefined,
    });
    const path = roadmapFile();
    const r = await call("POST", "/orchestration/import-roadmap", { path });
    expect(r.body.inserted).toBe(0);
    expect(r.body.skipped_existing).toBe(1);
    expect(await getBacklogItem(adapter, active.item_id)).toMatchObject({ readiness_state: "in_flight" });

    await adapter.query(`UPDATE orchestration_backlog_item SET readiness_state = 'done' WHERE item_id = ?`, [
      active.item_id,
    ]);
    const again = await call("POST", "/orchestration/import-roadmap", { path });
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped_existing).toBe(1);
  });

  it("refuses to promote a duplicate logical row when another copy is active", async () => {
    const parsed = parseRoadmapToBacklog(roadmapFileMarkdown(), { source_ref: "roadmap.md" });
    const logicalKey = parsed.items[0].logical_key;
    await insertBacklogItem(adapter, {
      title: "T-MODEL.1 - provider routing active",
      logical_key: logicalKey,
      readiness_state: "in_flight",
      risk_class: "build",
    });
    const dup = await insertBacklogItem(adapter, {
      title: "T-MODEL.1 - provider routing duplicate",
      logical_key: logicalKey,
      readiness_state: "needs_review",
      to_agent: "roger",
      dispatch_body: "do it again",
      risk_class: "build",
    });

    const promoted = await promoteToReady(adapter, dup.item_id, "test");
    expect(promoted.ok).toBe(false);
    expect(promoted.reason).toMatch(/logical work already in_flight/);

    await adapter.query(`UPDATE orchestration_backlog_item SET readiness_state = 'done' WHERE item_id <> ?`, [
      dup.item_id,
    ]);
    const stillBlocked = await promoteToReady(adapter, dup.item_id, "test");
    expect(stillBlocked.ok).toBe(false);
    expect(stillBlocked.reason).toMatch(/logical work already done/);
  });

  it("does not refuel duplicate skeletons when the logical work is already active or done", async () => {
    const parsed = parseRoadmapToBacklog(roadmapFileMarkdown(), { source_ref: "roadmap.md" });
    const logicalKey = parsed.items[0].logical_key;
    await insertBacklogItem(adapter, {
      title: "T-MODEL.1 - provider routing active",
      logical_key: logicalKey,
      readiness_state: "in_flight",
      risk_class: "build",
    });
    const duplicate = await insertBacklogItem(adapter, {
      title: "T-MODEL.1 - provider routing duplicate",
      logical_key: logicalKey,
      readiness_state: "needs_review",
      risk_class: "build",
    });

    const activeBlocked = await listFleshCandidates(adapter, {
      team_id: "default",
      item_ids: [duplicate.item_id],
    });
    expect(activeBlocked).toHaveLength(0);

    await adapter.query(
      `UPDATE orchestration_backlog_item SET readiness_state = 'done' WHERE logical_key = ? AND readiness_state = 'in_flight'`,
      [logicalKey],
    );
    const doneBlocked = await listFleshCandidates(adapter, {
      team_id: "default",
      item_ids: [duplicate.item_id],
    });
    expect(doneBlocked).toHaveLength(0);
  });
});

describe("daemon enqueue dedup key", () => {
  it("passes the roadmap logical_key into scheduler enqueue", async () => {
    const item = await insertBacklogItem(adapter, {
      title: "T-MODEL.1 - provider routing",
      logical_key: "roadmap:t-model-1:provider-routing",
      to_agent: "roger",
      dispatch_body: "route it",
      readiness_state: "ready",
      risk_class: "build",
    });
    const seen: Array<{ dedup_key?: string }> = [];
    const scheduler = {
      enqueue: async (input: { dedup_key?: string }) => {
        seen.push(input);
        return { dispatch_phid: "phid:disp-1", query_id: "q1" };
      },
      reactor: { listInFlight: async () => [] },
    };
    const usageService = {
      buildReport: async () => ({}) as never,
      buildDaemonReport: async () => ({
        gate: { hard_paused: false, enforcement: "enforce" as const },
        daily: { percent_consumed: null, combined_weighted_tokens: 0, budget: 1_000_000 },
        weekly: { percent_consumed: null, combined_weighted_tokens: 0, budget: 1_000_000 },
      }),
    };
    // RD-014: the factory wires a real agent-health resolver against `agents`
    // — seed roger as running so this test's admission isn't rejected as
    // "not healthy" for an agent that was simply never registered here.
    await adapter.query(`INSERT OR IGNORE INTO teams (id, name) VALUES ($1, $2)`, ["team-uuid-9999", "default"]);
    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["agent_roger", "team-uuid-9999", "roger", "claude", "claude-fable-5", 0, "running", Date.now()],
    );

    const { daemon } = createContinuousOrchestrationDaemon({
      adapter,
      scheduler: scheduler as never,
      usageService: usageService as never,
      config: { ...defaultConfig(), enabled: true, dry_run: false, max_in_flight: 1 },
    });
    await daemon.setMode("running");
    await daemon.runTick();

    expect(seen[0].dedup_key).toBe("roadmap:t-model-1:provider-routing");
    const after = await getBacklogItem(adapter, item.item_id);
    expect(after?.last_dispatch_phid).toBe("phid:disp-1");
  });
});

function roadmapFileMarkdown(): string {
  return [
    "| Sub-track | What | Status |",
    "|---|---|---|",
    "| **T-MODEL.1** - provider routing | route Codex Light provider fallback | NEEDS-CLARIFICATION |",
  ].join("\n");
}
