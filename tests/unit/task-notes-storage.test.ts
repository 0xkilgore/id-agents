import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import {
  consumeTaskNoteEvent,
  createTaskNoteEvent,
  listTaskNoteEvents,
  migrateTaskNoteTables,
} from "../../src/task-notes/storage.js";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateTaskNoteTables(adapter);
  const teams = new SqliteTeamsRepo(adapter);
  const teamId = await teams.getOrCreateTeamId("default");
  return { adapter, teamId };
}

describe("task note intake storage", () => {
  it("records note identity once and exposes it in the review queue", async () => {
    const { adapter, teamId } = await freshDb();
    const input = {
      team_id: teamId,
      task_ref: "task-md-123",
      source_path: "/Users/kilgore/Dropbox/Code/personal/to-do.md",
      source_project: "personal",
      line_number: 12,
      actor_ref: "user:chris",
      note_body: "can personal agent refire this research...",
      target_agent: "personal",
      routing_status: "routed" as const,
      nowIso: "2026-07-07T20:00:00.000Z",
    };

    const first = await createTaskNoteEvent(adapter, input);
    const second = await createTaskNoteEvent(adapter, input);

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.event.note_id).toBe(first.event.note_id);

    const queued = await listTaskNoteEvents(adapter, { teamId, status: "routed" });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      task_ref: "task-md-123",
      source_project: "personal",
      actor_ref: "user:chris",
      routing_status: "routed",
      target_agent: "personal",
    });
  });

  it("lets a load loop consume a task note exactly once", async () => {
    const { adapter, teamId } = await freshDb();
    const created = await createTaskNoteEvent(adapter, {
      team_id: teamId,
      task_ref: "task-md-456",
      actor_ref: "user:chris",
      note_body: "needs review",
      routing_status: "queued",
      nowIso: "2026-07-07T20:00:00.000Z",
    });

    const first = await consumeTaskNoteEvent(adapter, {
      teamId,
      noteId: created.event.note_id,
      consumer: "maestra-load-loop",
      nowIso: "2026-07-07T20:01:00.000Z",
    });
    const second = await consumeTaskNoteEvent(adapter, {
      teamId,
      noteId: created.event.note_id,
      consumer: "maestra-load-loop",
      nowIso: "2026-07-07T20:02:00.000Z",
    });

    expect(first.claimed).toBe(true);
    expect(first.event?.routing_status).toBe("consumed");
    expect(first.event?.consumed_by).toBe("maestra-load-loop");
    expect(second.claimed).toBe(false);
    expect(second.event?.consumed_at).toBe("2026-07-07T20:01:00.000Z");
  });
});
