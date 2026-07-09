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
    const body = await res.json() as any;
    expect(body.action_status).toBe("delivered");
    expect(body.recovery_status).toBe("moot");

    const got = await fetch(`${baseUrl}/dispatches/phid:disp-moot1`);
    const dispatch = (await got.json() as any).dispatch;
    expect(dispatch.effective_state).toBe("moot_or_superseded");
    expect(dispatch.needs_operator).toBe(false);
  });

  it("POST /dispatches/:id/moot is typed and idempotent when already moot", async () => {
    await seedFailed("phid:disp-moot2", "dead failure");
    const first = await post("/dispatches/phid:disp-moot2/moot", { reason: "not real work" });
    expect(first.status).toBe(200);

    const second = await post("/dispatches/phid:disp-moot2/moot", { reason: "clicked twice" });
    expect(second.status).toBe(200);
    const body = await second.json() as any;
    expect(body.action_status).toBe("delivered");
    expect(body.deduped).toBe(true);
    expect(body.recovery_status).toBe("moot");
  });

  it("POST /dispatches/:id/moot returns timed_out at the caller bound", async () => {
    await seedFailed("phid:disp-moot-slow", "dead failure");
    const scheduler = (manager as any).dispatchScheduler;
    const originalMarkMoot = scheduler.reactor.markMoot.bind(scheduler.reactor);
    scheduler.reactor.markMoot = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalMarkMoot(...args as [string, string]);
    };
    try {
      const res = await post("/dispatches/phid:disp-moot-slow/moot", {
        reason: "slow",
        timeout_ms: 5,
        idempotency_key: "slow-moot-key",
      });
      expect(res.status).toBe(504);
      const body = await res.json() as any;
      expect(body.action_status).toBe("timed_out");
      expect(body.idempotency_key).toBe("slow-moot-key");

      const retry = await post("/dispatches/phid:disp-moot-slow/moot", {
        reason: "slow",
        timeout_ms: 2000,
        idempotency_key: "slow-moot-key",
      });
      expect(retry.status).toBe(200);
      const retryBody = await retry.json() as any;
      expect(retryBody.action_status).toBe("delivered");
      expect(retryBody.deduped).toBe(true);
      expect(retryBody.recovery_status).toBe("moot");

      const got = await fetch(`${baseUrl}/dispatches/phid:disp-moot-slow`);
      const dispatch = (await got.json() as any).dispatch;
      expect(dispatch.effective_state).toBe("moot_or_superseded");
      expect(dispatch.recovery.status).toBe("moot");
    } finally {
      scheduler.reactor.markMoot = originalMarkMoot;
    }
  });

  it("POST /dispatches/:id/moot returns typed failed status for a missing dispatch", async () => {
    const res = await post("/dispatches/phid:disp-missing/moot", {});
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.action_status).toBe("failed");
    expect(body.error).toMatch(/dispatch not found/);
  });

  it("POST /dispatches/:id/retry re-enqueues + supersedes the original", async () => {
    await seedFailed("phid:disp-retry1", "transient");
    const res = await post("/dispatches/phid:disp-retry1/retry", {});
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action_status).toBe("delivered");
    expect(body.new_dispatch_phid).toMatch(/^phid:/);
    expect(body.superseded_dispatch_phid).toBe("phid:disp-retry1");

    const got = await fetch(`${baseUrl}/dispatches/phid:disp-retry1`);
    const dispatch = (await got.json() as any).dispatch;
    expect(dispatch.supersede_link).toBe(body.new_dispatch_phid);
    expect(dispatch.effective_state).toBe("moot_or_superseded");
  });

  it("POST /dispatches/:id/retry is bounded and same-key retry does not double-enqueue", async () => {
    await seedFailed("phid:disp-retry-slow", "transient");
    const scheduler = (manager as any).dispatchScheduler;
    const originalMarkSuperseded = scheduler.reactor.markSuperseded.bind(scheduler.reactor);
    scheduler.reactor.markSuperseded = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalMarkSuperseded(...args as [string, string, string]);
    };

    try {
      const body = { timeout_ms: 5, idempotency_key: "slow-retry-key" };
      const first = await post("/dispatches/phid:disp-retry-slow/retry", body);
      expect(first.status).toBe(504);
      const firstBody = await first.json() as any;
      expect(firstBody.action_status).toBe("timed_out");
      expect(firstBody.idempotency_key).toBe("slow-retry-key");

      const second = await post("/dispatches/phid:disp-retry-slow/retry", { ...body, timeout_ms: 2000 });
      expect(second.status).toBe(200);
      const secondBody = await second.json() as any;
      expect(secondBody.action_status).toBe("delivered");
      expect(secondBody.deduped).toBe(true);

      const queued = await db.adapter.query<{ dispatch_phid: string }>(
        `SELECT dispatch_phid FROM dispatch_scheduler_queue
         WHERE dedup_key = ?
         ORDER BY updated_at ASC`,
        ["operator-action:retry:phid:disp-retry-slow:finances"],
      );
      expect(queued.rows).toHaveLength(1);
      expect(secondBody.new_dispatch_phid).toBe(queued.rows[0].dispatch_phid);

      const got = await fetch(`${baseUrl}/dispatches/phid:disp-retry-slow`);
      const dispatch = (await got.json() as any).dispatch;
      expect(dispatch.effective_state).toBe("moot_or_superseded");
      expect(dispatch.recovery.status).toBe("moot");
      expect(dispatch.supersede_link).toBe(secondBody.new_dispatch_phid);
    } finally {
      scheduler.reactor.markSuperseded = originalMarkSuperseded;
    }
  });

  it("POST /dispatches/:id/reassign re-routes to a new agent", async () => {
    await seedFailed("phid:disp-reassign1", "wrong owner");
    const res = await post("/dispatches/phid:disp-reassign1/reassign", { to_agent: "regina" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action_status).toBe("delivered");
    expect(body.to_agent).toBe("regina");
    expect(body.new_dispatch_phid).toMatch(/^phid:/);
  });

  it("POST /dispatches/:id/reassign requires a typed failed status when to_agent is missing", async () => {
    await seedFailed("phid:disp-reassign-missing-agent", "wrong owner");
    const res = await post("/dispatches/phid:disp-reassign-missing-agent/reassign", {});
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.action_status).toBe("failed");
    expect(body.code).toBe("missing_to_agent");
  });

  it("POST /dispatches/:id/reassign is bounded and same-key retry does not double-enqueue", async () => {
    await seedFailed("phid:disp-reassign-slow", "wrong owner");
    const scheduler = (manager as any).dispatchScheduler;
    const originalMarkSuperseded = scheduler.reactor.markSuperseded.bind(scheduler.reactor);
    scheduler.reactor.markSuperseded = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalMarkSuperseded(...args as [string, string, string]);
    };

    try {
      const body = { timeout_ms: 5, idempotency_key: "slow-reassign-key", to_agent: "regina" };
      const first = await post("/dispatches/phid:disp-reassign-slow/reassign", body);
      expect(first.status).toBe(504);
      const firstBody = await first.json() as any;
      expect(firstBody.action_status).toBe("timed_out");
      expect(firstBody.idempotency_key).toBe("slow-reassign-key");

      const second = await post("/dispatches/phid:disp-reassign-slow/reassign", { ...body, timeout_ms: 2000 });
      expect(second.status).toBe(200);
      const secondBody = await second.json() as any;
      expect(secondBody.action_status).toBe("delivered");
      expect(secondBody.deduped).toBe(true);
      expect(secondBody.to_agent).toBe("regina");

      const queued = await db.adapter.query<{ dispatch_phid: string }>(
        `SELECT dispatch_phid FROM dispatch_scheduler_queue
         WHERE dedup_key = ?
         ORDER BY updated_at ASC`,
        ["operator-action:reassign:phid:disp-reassign-slow:regina"],
      );
      expect(queued.rows).toHaveLength(1);
      expect(secondBody.new_dispatch_phid).toBe(queued.rows[0].dispatch_phid);

      const got = await fetch(`${baseUrl}/dispatches/phid:disp-reassign-slow`);
      const dispatch = (await got.json() as any).dispatch;
      expect(dispatch.effective_state).toBe("moot_or_superseded");
      expect(dispatch.recovery.status).toBe("moot");
      expect(dispatch.supersede_link).toBe(secondBody.new_dispatch_phid);
    } finally {
      scheduler.reactor.markSuperseded = originalMarkSuperseded;
    }
  });

  it("POST /dispatches/:id/retry reuses the replacement dispatch after a partial failure", async () => {
    await seedFailed("phid:disp-retry-partial", "transient");
    const scheduler = (manager as any).dispatchScheduler;
    const originalMarkSuperseded = scheduler.reactor.markSuperseded.bind(scheduler.reactor);
    let failedOnce = false;
    scheduler.reactor.markSuperseded = async (...args: unknown[]) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("simulated supersede failure");
      }
      return originalMarkSuperseded(...args as [string, string, string]);
    };
    try {
      const first = await post("/dispatches/phid:disp-retry-partial/retry", {});
      expect(first.status).toBe(500);
      const firstBody = await first.json() as any;
      expect(firstBody.action_status).toBe("failed");

      const queued = await db.adapter.query<{ dispatch_phid: string }>(
        `SELECT dispatch_phid FROM dispatch_scheduler_queue
         WHERE dedup_key = ?
         ORDER BY updated_at ASC`,
        ["operator-action:retry:phid:disp-retry-partial:finances"],
      );
      expect(queued.rows).toHaveLength(1);
      const replacement = queued.rows[0].dispatch_phid;

      const second = await post("/dispatches/phid:disp-retry-partial/retry", {});
      expect(second.status).toBe(200);
      const secondBody = await second.json() as any;
      expect(secondBody.action_status).toBe("delivered");
      expect(secondBody.new_dispatch_phid).toBe(replacement);

      const after = await fetch(`${baseUrl}/dispatches/phid:disp-retry-partial`);
      const dispatch = (await after.json() as any).dispatch;
      expect(dispatch.supersede_link).toBe(replacement);
    } finally {
      scheduler.reactor.markSuperseded = originalMarkSuperseded;
    }
  });

  it("rejects an unauthenticated (non-admin) operator action", async () => {
    await seedFailed("phid:disp-noauth", "x");
    const res = await fetch(`${baseUrl}/dispatches/phid:disp-noauth/moot`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.action_status).toBe("failed");
  });
});
