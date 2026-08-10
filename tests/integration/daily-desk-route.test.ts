import express from "express";
import type { Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManagerDb } from "../../src/agent-manager-db.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import type { TasksRepository } from "../../src/db/db-service.js";
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
import { artifactIdFromPath } from "../../src/outputs/storage.js";
import { mountDailyDeskRoutes } from "../../src/daily-desk/routes.js";
import { migrateDailyDeskTables, upsertDailyDeskRegistration } from "../../src/daily-desk/storage.js";
import type { DailyDeskSourceSet } from "../../src/daily-desk/types.js";
import { upsertInboxItem } from "../../src/inbox/storage.js";
import type { InboxItemRow } from "../../src/inbox/types.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("GET /daily-desk", () => {
  it("returns the versioned bounded manager contract once per request and fails closed on an invalid date", async () => {
    const adapter = new SqliteAdapter(":memory:");
    const app = express();
    let loadCount = 0;
    mountDailyDeskRoutes(app, adapter, {
      tasks: {} as TasksRepository,
      resolveTeamId: async () => "team-1",
      now: () => NOW,
      loadSources: async () => {
        loadCount += 1;
        return emptySource();
      },
    });
    server = await listen(app);
    const base = address(server);
    const response = await fetch(`${base}/daily-desk?today=2026-08-05`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(loadCount).toBe(1);
    expect(body).toMatchObject({
      schema_version: "daily-desk.v1",
      authority: { owner: "manager", projection: "daily_desk", state: "authoritative" },
      max_payload_bytes: 65536,
    });
    expect(response.headers.get("server-timing")).toMatch(/daily-desk-projection/);
    expect(response.headers.get("x-daily-desk-payload-bytes")).toBe(String(body.payload_bytes));
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(body.payload_bytes);

    const invalid = await fetch(`${base}/daily-desk?today=2026-02-31`);
    expect(invalid.status).toBe(400);
    expect(loadCount).toBe(1);
  });

  it("migrates and upserts only additive Daily Desk metadata", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateDailyDeskTables(adapter);
    const saved = await upsertDailyDeskRegistration(adapter, {
      team_id: "team-1", lane: "needs_response", entity_kind: "inbox", entity_id: "inbox-prod-1",
      audience: "operator", environment: "production", owner: "cane", canonical_url: "/ops/inboxes?item=inbox-prod-1",
      effective_lifecycle: "needs_response", source_as_of: "2026-08-05T11:00:00.000Z",
      admission_code: "operator_response_required", admission_detail: "unresolved production response",
      permitted_actions: ["open", "acknowledge", "open"],
    }, NOW.toISOString());
    expect(saved).toMatchObject({
      team_id: "team-1", lane: "needs_response", entity_kind: "inbox", entity_id: "inbox-prod-1",
      audience: "operator", environment: "production",
    });
    expect(JSON.parse(saved.permitted_actions_json)).toEqual(["open", "acknowledge"]);
    const tables = await adapter.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    expect(tables.rows.map((row) => row.name)).toContain("daily_desk_lane_metadata");
    expect(tables.rows.map((row) => row.name)).not.toContain("artifact_review_next_metadata");
  });

  it("wires explicit artifact and operator-owned checkin admission through real manager routes", async () => {
    const db = await createInMemoryDb();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-desk-admission-"));
    const port = await freePort();
    const manager = new AgentManagerDb(workDir, db as any);
    const base = `http://127.0.0.1:${port}`;
    const team = "daily-desk-admission";
    const manualArtifactId = "daily-driver-stability-execution-2026-08-07";
    const headers = { "content-type": "application/json", "x-id-team": team, "x-id-admin": "1" };
    try {
      await manager.start(port);
      const teamId = await db.teams.getOrCreateTeamId(team);
      await insertAgent(db.adapter, teamId, "cane");
      await insertAgent(db.adapter, await db.teams.getOrCreateTeamId("default"), "cane");
      const today = new Date().toISOString().slice(0, 10);
      const nowIso = new Date().toISOString();

      await postJson(base, "/tasks", headers, {
        title: `Prepare operator packet due:${today}`,
        name: "prepare-operator-packet",
        from: "cane",
      }, 201);
      await postJson(base, "/tasks", headers, {
        title: "System test watch",
        name: "system-test-watch",
        from: "cane",
      }, 201);

      const review = (id: string, overrides: Record<string, unknown> = {}) => ({
        audience: "operator",
        environment: "production",
        owner: "cane",
        canonical_url: `/ops/artifacts/${id}`,
        effective_lifecycle: "needs_review",
        source_as_of: nowIso,
        attention_state: "needs_review",
        attention_reason: "fresh operator deliverable",
        attention_priority: 1,
        admission_reason: "explicit operator registration",
        permitted_actions: ["open", "comment", "approve"],
        ...overrides,
      });
      const artifact = async (id: string, source: "agent-done" | "manual", extra: Record<string, unknown> = {}) =>
        postJson(base, "/artifacts/register", headers, {
          artifact_id: id,
          basename: `${id}.md`,
          agent: "cane",
          abs_path: `/operator/output/${id}.md`,
          title: `Artifact ${id}`,
          produced_at: nowIso,
          source,
          project_ref: "kapelle",
          ...extra,
        });
      const agentDonePath = path.join(workDir, "operator-review.md");
      fs.writeFileSync(agentDonePath, "# Operator review\n");
      const agentDoneId = artifactIdFromPath(agentDonePath);
      const dispatch = await postJson(base, "/dispatch/enqueue", headers, {
        to_agent: "cane",
        from_actor: "operator",
        message: "prepare the operator review",
        subject: "Operator review artifact",
      }) as any;
      await postJson(base, "/agent-done", headers, {
        dispatch_id: dispatch.dispatch_phid,
        success: true,
        agent: "cane",
        result: {
          artifact_path: agentDonePath,
          title: "Operator review artifact",
          project_ref: "kapelle",
          review_next: review(agentDoneId),
        },
      });
      await artifact(manualArtifactId, "manual", { review_next: review(manualArtifactId, { attention_priority: 2 }) });
      await artifact("art-not-explicit", "agent-done");
      await artifact("art-test-fixture", "manual", {
        abs_path: "/repo/tests/fixtures/art-test-fixture.md",
        review_next: review("art-test-fixture"),
      });
      await artifact("art-system-row", "manual", {
        review_next: review("art-system-row", { audience: "system" }),
      });

      const taskResponse = await fetch(`${base}/tasks`, { headers }).then((response) => response.json()) as any;
      const operatorTask = taskResponse.tasks.find((task: any) => task.name === "prepare-operator-packet");
      expect(operatorTask).toBeDefined();
      const admittedCheckin = await postJson(base, "/checkins", headers, {
        owner: "cane",
        linked_task: "prepare-operator-packet",
        note: "Confirm operator packet outcome",
      }, 201) as any;
      const excludedCheckin = await postJson(base, "/checkins", headers, {
        owner: "cane",
        linked_task: "system-test-watch",
        note: "System-only fixture",
      }, 201) as any;
      await postJson(base, "/checkins", headers, {
        linked_task: "prepare-operator-packet",
        note: "Unowned system watch",
      }, 201);

      await upsertInboxItem(db.adapter, inbox("inbox-operator", nowIso));
      await upsertInboxItem(db.adapter, inbox("inbox-reference", nowIso, { classification_label: "reference" }));
      for (const id of ["inbox-operator", "inbox-reference"]) {
        await upsertDailyDeskRegistration(db.adapter, {
          team_id: teamId,
          lane: "needs_response",
          entity_kind: "inbox",
          entity_id: id,
          audience: "operator",
          environment: "production",
          owner: "cane",
          canonical_url: `/ops/inboxes?item=${id}`,
          effective_lifecycle: "needs_response",
          source_as_of: nowIso,
          admission_code: "operator_response_required",
          admission_detail: "unresolved production response",
          permitted_actions: ["open", "acknowledge"],
        }, nowIso);
      }

      const desk = await fetch(`${base}/daily-desk?today=${today}`, { headers }).then((response) => response.json()) as any;
      expect(desk.schema_version).toBe("daily-desk.v1");
      expect(laneMembership(desk)).toEqual({
        today: [operatorTask.id],
        review_next: [agentDoneId, manualArtifactId],
        needs_response: ["inbox-operator"],
        follow_through: [admittedCheckin.checkin.id],
      });
      expect(desk.lanes.flatMap((lane: any) => lane.rows.map((row: any) => row.id))).not.toContain(excludedCheckin.checkin.id);

      const taskview = await fetch(`${base}/tasks/entries?today=${today}`, { headers }).then((response) => response.json()) as any;
      expect(desk.lanes[0].rows.map((row: any) => row.id)).toEqual(
        taskview.items.filter((entry: any) => entry.band === "today").map((entry: any) => entry.phid),
      );
      const reviewNext = await fetch(`${base}/artifacts/review-next`, { headers }).then((response) => response.json()) as any;
      expect(desk.lanes[1].rows.map((row: any) => row.id)).toEqual(reviewNext.rows.map((row: any) => row.id));
      expect(reviewNext.rows.find((row: any) => row.id === manualArtifactId)?.permitted_actions).toEqual([
        "open",
        "approve",
      ]);
      const inboxItems = await fetch(`${base}/inbox/items`, { headers }).then((response) => response.json()) as any;
      expect(desk.lanes[2].rows.map((row: any) => row.id)).toEqual(
        inboxItems.items.filter((item: any) => item.classification_label === "action").map((item: any) => item.inbox_phid),
      );

      await postJson(base, `/artifacts/${manualArtifactId}/approve`, headers, { actor_ref: "user:chris" });
      const afterCustomIdApproval = await fetch(`${base}/daily-desk?today=${today}`, { headers }).then((response) => response.json()) as any;
      expect(laneMembership(afterCustomIdApproval).review_next).toEqual([agentDoneId]);

      await postJson(base, `/artifacts/${agentDoneId}/approve`, headers, { actor_ref: "user:chris" });
      await postJson(base, `/checkins/${admittedCheckin.checkin.id}/close`, headers, { reason: "verified" });
      const after = await fetch(`${base}/daily-desk?today=${today}`, { headers }).then((response) => response.json()) as any;
      expect(laneMembership(after)).toEqual({
        today: [operatorTask.id],
        review_next: [],
        needs_response: ["inbox-operator"],
        follow_through: [],
      });
    } finally {
      await stopManager(manager);
      await db.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function emptySource(): DailyDeskSourceSet {
  return { today: [], review_next_source: [], needs_response: [], follow_through: [] };
}

async function listen(app: express.Application): Promise<Server> {
  return new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
}

function address(instance: Server): string {
  const bound = instance.address();
  if (!bound || typeof bound === "string") throw new Error("missing test port");
  return `http://127.0.0.1:${bound.port}`;
}

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

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<void> {
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, `agent_${crypto.randomUUID()}`, name, "persistent", "claude-opus", 24000, "http://127.0.0.1:19999", "active", Date.now(), "claude-code"],
  );
}

function inbox(id: string, nowIso: string, overrides: Partial<InboxItemRow> = {}): InboxItemRow {
  return {
    inbox_phid: id,
    operator_state: "new",
    source_kind: "email",
    source_external_id: `production-${id}`,
    source_text: "Please respond",
    source_excerpt: "Please respond",
    source_subject: `Inbox ${id}`,
    source_from: "person@example.com",
    classification_label: "action",
    classification_confidence: 1,
    classification_classifier: "human",
    classification_rationale: "operator response requested",
    project_hint: null,
    agent_hint: null,
    origin_ref: null,
    received_at: nowIso,
    triaged_at: null,
    resolved_at: null,
    snoozed_until: null,
    checked_off_at: null,
    checked_off_reason: null,
    source: "index",
    parity_status: "ok",
    generated_at: nowIso,
    projection_version: 1,
    legacy_inbox_md_line: null,
    legacy_shadow_path: null,
    read_at: null,
    ...overrides,
  };
}

async function postJson(base: string, route: string, headers: Record<string, string>, body: unknown, status = 200): Promise<unknown> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload;
}

function laneMembership(body: any): Record<string, string[]> {
  return Object.fromEntries(body.lanes.map((lane: any) => [lane.id, lane.rows.map((row: any) => row.id)]));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1", () => {
      const bound = listener.address() as { port: number };
      listener.close(() => resolve(bound.port));
    });
    listener.on("error", reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}
