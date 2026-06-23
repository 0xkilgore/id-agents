// T-RECON.2 (2026-06-22) — operator-action endpoints (Regina wires the UI):
// POST /dispatches/:id/{moot,retry,reassign}. Exercised end-to-end on the live
// manager (admin = loopback + X-Id-Admin:1).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteSubscriptionsRepo } from "../../src/db/repos/sqlite/subscriptions-repo.js";
import { SqliteCheckinsRepo } from "../../src/db/repos/sqlite/checkins-repo.js";

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

const ADMIN = { "content-type": "application/json", "x-id-admin": "1" };

describe("T-RECON.2 operator-action endpoints", () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "recon2-ep-"));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId("default");
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Seed a failed dispatch row directly, then return its phid.
  async function seedFailed(phid: string, detail: string): Promise<void> {
    const now = new Date().toISOString();
    await db.adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
          body_markdown, provider, runtime, priority, status, failure_kind, failure_detail,
          not_before_at, updated_at, clarification_history_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [phid, teamId, `q-${phid}`, "finances", "manager", "dispatch", "do the thing",
       "the original task body", "anthropic", "claude-code-cli", 5, "failed", "agent_error", detail,
       now, now, "[]"],
    );
  }

  const post = (p: string, body: unknown) =>
    fetch(`${baseUrl}${p}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });

  it("POST /dispatches/:id/moot dismisses a dead failure out of NEEDS-YOU", async () => {
    await seedFailed("phid:disp-moot1", "dead failure");
    const res = await post("/dispatches/phid:disp-moot1/moot", { reason: "not real work" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).recovery_status).toBe("moot");

    const got = await fetch(`${baseUrl}/dispatches/phid:disp-moot1`);
    const dispatch = (await got.json() as any).dispatch;
    expect(dispatch.effective_state).toBe("moot_or_superseded");
    expect(dispatch.needs_operator).toBe(false);
  });

  it("POST /dispatches/:id/retry re-enqueues + supersedes the original", async () => {
    await seedFailed("phid:disp-retry1", "transient");
    const res = await post("/dispatches/phid:disp-retry1/retry", {});
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.new_dispatch_phid).toMatch(/^phid:/);
    expect(body.superseded_dispatch_phid).toBe("phid:disp-retry1");

    const got = await fetch(`${baseUrl}/dispatches/phid:disp-retry1`);
    const dispatch = (await got.json() as any).dispatch;
    expect(dispatch.supersede_link).toBe(body.new_dispatch_phid);
    expect(dispatch.effective_state).toBe("moot_or_superseded");
  });

  it("POST /dispatches/:id/reassign re-routes to a new agent", async () => {
    await seedFailed("phid:disp-reassign1", "wrong owner");
    const res = await post("/dispatches/phid:disp-reassign1/reassign", { to_agent: "regina" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.to_agent).toBe("regina");
    expect(body.new_dispatch_phid).toMatch(/^phid:/);
  });

  it("rejects an unauthenticated (non-admin) operator action", async () => {
    await seedFailed("phid:disp-noauth", "x");
    const res = await fetch(`${baseUrl}/dispatches/phid:disp-noauth/moot`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
