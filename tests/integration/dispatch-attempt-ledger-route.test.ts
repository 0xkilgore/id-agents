import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import crypto from "node:crypto";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
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

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
    server.on("error", reject);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 500);
  });
}

describe("dispatch attempt ledger route", () => {
  const savedGatewayMode = process.env.DISPATCH_GATEWAY_MODE;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let targetServer: http.Server;

  beforeAll(async () => {
    process.env.DISPATCH_GATEWAY_MODE = "off";
    targetServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/talk") {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "forced talk failure" }));
        return;
      }
      if (req.method === "POST" && req.url === "/news") {
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, triggered: true, query_id: "news_q_1" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const targetPort = await listen(targetServer);
    db = await createInMemoryDb();
    const teamId = await db.teams.getOrCreateTeamId("default");
    await db.adapter.query(
      `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        teamId,
        `agent_${crypto.randomUUID()}`,
        "ledger-target",
        "persistent",
        "gpt-test",
        targetPort,
        `http://127.0.0.1:${targetPort}`,
        "active",
        Date.now(),
        "codex",
      ],
    );
    const managerPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-attempt-ledger-route-"));
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);
  }, 30000);

  afterAll(async () => {
    await manager?.shutdown();
    await closeServer(targetServer);
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (savedGatewayMode === undefined) delete process.env.DISPATCH_GATEWAY_MODE;
    else process.env.DISPATCH_GATEWAY_MODE = savedGatewayMode;
  });

  it("records one ledger row for a failed /talk-to followed by /news-to fallback", async () => {
    const body = {
      to: "ledger-target",
      from: "continuous-orchestration",
      message: "urgent Cleveland Park and finances tasks",
      query_id: "query_1783439711510_sacmggk",
      dispatch_id: "phid:disp-route-ledger",
    };
    const talk = await fetch(`${baseUrl}/talk-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": "default" },
      body: JSON.stringify(body),
    });
    expect(talk.status).toBe(502);

    const news = await fetch(`${baseUrl}/news-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": "default" },
      body: JSON.stringify({ ...body, trigger: true }),
    });
    expect(news.status).toBe(202);

    const ledger = await fetch(`${baseUrl}/dispatch-attempt-ledger`, {
      headers: { "X-Id-Team": "default" },
    });
    expect(ledger.status).toBe(200);
    const payload = await ledger.json() as any;
    expect(payload.attempts).toHaveLength(1);
    expect(payload.attempts[0]).toMatchObject({
      to_agent: "ledger-target",
      original_query_id: "query_1783439711510_sacmggk",
      original_dispatch_id: "phid:disp-route-ledger",
      talk_to_attempted: true,
      talk_to_ok: false,
      talk_to_status_code: 502,
      news_to_attempted: true,
      news_to_ok: true,
      news_to_status_code: 202,
      fallback_used: true,
      fallback_ok: true,
    });
  });
});
