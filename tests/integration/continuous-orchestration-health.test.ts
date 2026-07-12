import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
import {
  insertBacklogItem,
  recordTickOutcome,
  setMode,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteCheckinsRepo } from "../../src/db/repos/sqlite/checkins-repo.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteSubscriptionsRepo } from "../../src/db/repos/sqlite/subscriptions-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

describe("continuous orchestration console health", () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-health-test-"));
    db = await createInMemoryDb();
    await db.teams.getOrCreateTeamId("default");
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { await db?.close(); } catch { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("surfaces 8 ready items and 170 no-op ticks as stalled_ready_not_launching on /health/console", async () => {
    await setMode(db.adapter, "default", "running");
    for (let i = 0; i < 8; i += 1) {
      await insertBacklogItem(db.adapter, {
        title: `ready item ${i + 1}`,
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "continue",
      });
    }
    await recordTickOutcome(db.adapter, "default", { zero_ticks: 170, fired: false });

    const res = await fetch(`${baseUrl}/health/console`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.ok).toBe(false);
    expect(body.orchestration).toMatchObject({
      state: "stalled_ready_not_launching",
      ready_count: 8,
      admissible_now: 0,
      actionable_ready_count: 0,
      noop_tick_count: 170,
      last_noop_reason: null,
      scheduler_loop_id: "continuous-orchestration:default",
    });
    expect(body.orchestration.ready_blocked_by_reason).toEqual(expect.any(Object));
    expect(body.orchestration.admission_breakdown).toMatchObject({
      ready_count: 8,
      admitting_count: 0,
      lanes: [
        {
          lane: "roger",
          ready_count: 8,
          admitting_count: 0,
        },
      ],
    });
  });

  it("also embeds the console health projection on /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.status).toBe("ok");
    expect(body.console.orchestration.state).toBe("stalled_ready_not_launching");
    expect(body.console.orchestration.ready_count).toBe(8);
    expect(body.console.orchestration.admissible_now).toBe(0);
    expect(body.console.orchestration.ready_blocked_by_reason).toEqual(expect.any(Object));
    expect(body.console.orchestration.noop_tick_count).toBe(170);
    expect(body.console.orchestration.admission_breakdown?.lanes?.[0]).toMatchObject({
      lane: "roger",
      ready_count: 8,
      admitting_count: 0,
    });
  });
});
