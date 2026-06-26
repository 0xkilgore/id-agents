import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteNewsRepo } from "../../src/db/repos/sqlite/news-repo.js";
import { SqliteQueriesRepo } from "../../src/db/repos/sqlite/queries-repo.js";
import { SqliteSchedulesRepo } from "../../src/db/repos/sqlite/schedules-repo.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";

const SOURCE_MD = `# Kapelle Decisions Log

## OPEN <=60s items (canonical lookup; rebuilt on every resolution)

| # | One-line | Recommend | Status |
|---|---|---|---|
| 53 | Cane FIX 1 - document /agent-done response codes clearly | Chris re-check before dispatch | OPEN - Chris re-check needed |
| 77 | AGPL/OSS-lift standing directive | YES adopted | RESOLVED 2026-06-16 PM |
`;

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

describe("manager GET /decisions/queue", () => {
  let port: number;
  let baseUrl: string;
  let workDir: string;
  let sourcePath: string;
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  const oldSource = process.env.DECISIONS_QUEUE_SOURCE_PATH;
  const oldAuto = process.env.DECISIONS_QUEUE_AUTOINGEST;

  beforeAll(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-decisions-queue-"));
    sourcePath = path.join(workDir, "kapelle-decisions-queue.md");
    fs.writeFileSync(sourcePath, SOURCE_MD);
    process.env.DECISIONS_QUEUE_SOURCE_PATH = sourcePath;
    process.env.DECISIONS_QUEUE_AUTOINGEST = "true";

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    if (oldSource === undefined) delete process.env.DECISIONS_QUEUE_SOURCE_PATH;
    else process.env.DECISIONS_QUEUE_SOURCE_PATH = oldSource;
    if (oldAuto === undefined) delete process.env.DECISIONS_QUEUE_AUTOINGEST;
    else process.env.DECISIONS_QUEUE_AUTOINGEST = oldAuto;
    try { await manager?.shutdown(); } catch { /* ignore */ }
    try { await db?.close(); } catch { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns the OP-1 queue envelope backed by the configured markdown source on first read", async () => {
    const res = await fetch(`${baseUrl}/decisions/queue?status=open&limit=8`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.schema_version).toBe("decisions.queue.v1");
    expect(body.source).toMatchObject({
      system: "manager",
      projection: "decisions_queue",
      source_type: "maestra_decisions_markdown",
    });
    expect(body.provenance.producer).toBe("maestra");
    expect(body.provenance.source_paths).toEqual([sourcePath]);
    expect(body.filters).toMatchObject({ status: "open", max_estimated_seconds: 60, limit: 8 });
    expect(body.counts.open).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      display_id: "#53",
      title: "Cane FIX 1 - document /agent-done response codes clearly",
      status: "open",
      decide: {
        method: "POST",
        one_tap_option_id: "skip",
        requires_note: false,
        confirmation: "none",
      },
    });
    expect(body.items[0].decision_id).toMatch(/^dec_[a-f0-9]{16}$/);
    expect(body.items[0].decide.path).toBe(`/decisions/${body.items[0].decision_id}/decide`);
    expect(body.items[0].decide.idempotency_key_seed).toBe(
      `decision:decide:v1:${body.items[0].decision_id}:skip:human:chris`,
    );
    expect(body.warnings).toEqual([]);
  });
});
