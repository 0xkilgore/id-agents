import { describe, expect, it, beforeEach, vi } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateInboxTables, getInboxItem, getLinks } from "../../src/inbox/storage.js";
import { ingestForwardedEmail } from "../../src/inbox-email/intake.js";
import { normalizeAliasAddress, upsertEmailAlias } from "../../src/inbox-email/storage.js";
import type { TaskRow } from "../../src/db/types.js";
import type { TasksRepository } from "../../src/db/db-service.js";
import type { EnqueueInputV2 } from "../../src/dispatch-scheduler/manager-integration.js";

class TestTasksRepo implements TasksRepository {
  created: TaskRow[] = [];
  constructor(private readonly adapter: SqliteAdapter) {}

  async create(task: TaskRow): Promise<void> {
    this.created.push(task);
    await this.adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        task.id,
        task.name,
        task.uuid,
        task.team_id,
        task.title,
        task.description,
        task.status,
        task.created_by,
        task.owner,
        task.created_at,
        task.updated_at,
        task.completed_at,
        task.track,
      ],
    );
  }

  async getByName(): Promise<TaskRow | null> { return null; }
  async getByNameForTeam(): Promise<TaskRow | null> { return null; }
  async getByUuidPrefix(): Promise<TaskRow[]> { return []; }
  async list(): Promise<TaskRow[]> { return this.created; }
  async updateFields(): Promise<void> {}
  async claim(): Promise<boolean> { return false; }
  async delete(): Promise<void> {}
  async replaceEventLinks(): Promise<void> {}
  async listEventLinksForTask(): Promise<Array<{ schedule_id: string }>> { return []; }
}

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(":memory:");
  migrateInboxTables(adapter);
  adapter.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT,
      owner TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      track TEXT NOT NULL DEFAULT '(unassigned)',
      UNIQUE(team_id, name)
    )
  `);
  return adapter;
}

describe("CoS email intake", () => {
  let adapter: SqliteAdapter;
  let tasks: TestTasksRepo;

  beforeEach(async () => {
    adapter = makeAdapter();
    tasks = new TestTasksRepo(adapter);
    await upsertEmailAlias(adapter, {
      team_id: "team-default",
      user_id: "operator",
      address: "operator+cos@agents.example",
      default_project: "kapelle",
      now: new Date("2026-06-29T12:00:00.000Z"),
    });
  });

  it("normalizes plus-address aliases for per-user routing", () => {
    expect(normalizeAliasAddress("Operator+CoS@Agents.Example")).toBe("operator@agents.example");
  });

  it("creates a triaged task for a forwarded email without an agent route", async () => {
    const result = await ingestForwardedEmail(adapter, {
      team_id: "team-default",
      to: "operator@agents.example",
      from: "sender@example.com",
      subject: "Review Monday load-up",
      text: "Please turn this into a follow-up.",
      message_id: "<msg-1@example.com>",
      received_at: "2026-06-29T12:05:00.000Z",
    }, { tasks, now: () => new Date("2026-06-29T12:06:00.000Z") });

    expect(result.action).toBe("task");
    expect(result.task_name).toBe("review-monday-load-up");
    expect(tasks.created).toHaveLength(1);
    expect(tasks.created[0].team_id).toBe("team-default");
    expect(tasks.created[0].track).toBe("kapelle");

    const item = await getInboxItem(adapter, result.inbox_phid);
    expect(item?.source_kind).toBe("email");
    expect(item?.project_hint).toBe("kapelle");
    expect(item?.operator_state).toBe("needs_route");
    await expect(getLinks(adapter, result.inbox_phid)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "task", target: "review-monday-load-up" })]),
    );
  });

  it("enqueues a dispatch when the email contains an agent directive", async () => {
    const enqueueDispatch = vi.fn(async (input: EnqueueInputV2) => ({
      query_id: "query-email-1",
      dispatch_phid: "phid:disp-email-1",
      status: "queued" as const,
    }));

    const result = await ingestForwardedEmail(adapter, {
      team_id: "team-default",
      to: "operator@agents.example",
      from: "sender@example.com",
      subject: "[dispatch:substrate-api-codex] Build intake",
      text: "Wire this to the CoS.",
      message_id: "<msg-2@example.com>",
      received_at: "2026-06-29T12:10:00.000Z",
    }, { tasks, enqueueDispatch, now: () => new Date("2026-06-29T12:11:00.000Z") });

    expect(result.action).toBe("dispatch");
    expect(result.dispatch_phid).toBe("phid:disp-email-1");
    expect(tasks.created).toHaveLength(0);
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: "team-default",
        to_agent: "substrate-api-codex",
        channel: "email",
        subject: "[dispatch:substrate-api-codex] Build intake",
      }),
      { wake: true },
    );
    await expect(getLinks(adapter, result.inbox_phid)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "dispatch", target: "phid:disp-email-1" })]),
    );
  });

  it("is idempotent by message id", async () => {
    const input = {
      team_id: "team-default",
      to: "operator@agents.example",
      from: "sender@example.com",
      subject: "Same message",
      text: "Only one task should be created.",
      message_id: "<msg-3@example.com>",
      received_at: "2026-06-29T12:20:00.000Z",
    };

    const first = await ingestForwardedEmail(adapter, input, { tasks });
    const second = await ingestForwardedEmail(adapter, input, { tasks });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.inbox_phid).toBe(first.inbox_phid);
    expect(tasks.created).toHaveLength(1);
  });
});
