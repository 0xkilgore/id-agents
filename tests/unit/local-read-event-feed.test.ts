import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import type { EventsRepository } from "../../src/db/db-service.js";
import type { EventLogRow } from "../../src/db/types.js";
import { mountLocalReadEventRoutes } from "../../src/local-search/index.js";

class FakeEventsRepo implements EventsRepository {
  constructor(private readonly rows: EventLogRow[]) {}

  async insert(): Promise<{ seq: number }> {
    throw new Error("not implemented");
  }

  async query(opts: { teamId: string; sinceSeq?: number; topics?: string[]; limit?: number }): Promise<EventLogRow[]> {
    const topics = opts.topics ? new Set(opts.topics) : null;
    return this.rows
      .filter((row) => row.team_id === opts.teamId)
      .filter((row) => opts.sinceSeq === undefined || row.seq > opts.sinceSeq)
      .filter((row) => !topics || topics.has(row.topic))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, opts.limit ?? 100);
  }

  async earliestSeq(teamId: string): Promise<number | null> {
    const seqs = this.rows.filter((row) => row.team_id === teamId).map((row) => row.seq);
    return seqs.length > 0 ? Math.min(...seqs) : null;
  }

  async pruneByAge(): Promise<number> {
    return 0;
  }

  async pruneByCount(): Promise<number> {
    return 0;
  }

  async countForTeam(teamId: string): Promise<number> {
    return this.rows.filter((row) => row.team_id === teamId).length;
  }
}

function row(overrides: Partial<EventLogRow>): EventLogRow {
  return {
    seq: 1,
    team_id: "team-a-id",
    topic: "task:updated",
    actor_agent_id: null,
    subject_kind: "task",
    subject_id: "task-a",
    occurred_at: Date.parse("2026-07-10T12:00:00.000Z"),
    data: {},
    ...overrides,
  };
}

function bootApp(rows: EventLogRow[]): Express {
  const app = express();
  mountLocalReadEventRoutes(app, {
    events: new FakeEventsRepo(rows),
    async resolveTeam() {
      return { id: "team-a-id", name: "team-a" };
    },
  });
  return app;
}

async function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const json = await response.json();
        server.close(() => resolve({ status: response.status, body: json }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe("local read-model event feed", () => {
  it("resumes after a cursor and returns targeted invalidation keys", async () => {
    const app = bootApp([
      row({ seq: 1, topic: "artifact:metadata_changed", subject_kind: "artifact", subject_id: "artifact-a" }),
      row({ seq: 2, topic: "artifact:body_changed", subject_kind: "artifact", subject_id: "artifact-a" }),
      row({ seq: 3, topic: "task:completed", subject_kind: "task", subject_id: "uuid-a", data: { task_name: "task-a" } }),
      row({ seq: 4, topic: "query:delivered", subject_kind: "query", subject_id: "query-a" }),
    ]);

    const { status, body } = await getJson(app, "/read-model/events?since=1&limit=10");

    expect(status).toBe(200);
    expect(body.schemaVersion).toBe("read_model.events.v0");
    expect(body.cursor).toMatchObject({ since: 1, next: 3, expired: false, earliestAvailableSeq: 1 });
    expect(body.events.map((event: any) => event.id)).toEqual(["event_log:2", "event_log:3"]);
    expect(body.events[0]).toMatchObject({
      kind: "artifact_body_changed",
      entity: { type: "artifact", id: "artifact-a" },
      invalidateKeys: [
        "artifact:artifact-a",
        "artifact:artifact-a:detail",
        "artifact:artifact-a:body",
        "artifact:artifact-a:timeline",
      ],
      resyncScopes: [{ type: "artifact", id: "artifact-a", reason: "artifact_body_changed" }],
    });
    expect(body.events[1]).toMatchObject({
      kind: "task_changed",
      entity: { type: "task", id: "task-a" },
      invalidateKeys: ["task:task-a"],
      resyncScopes: [{ type: "task", id: "task-a", reason: "task:completed" }],
    });
  });

  it("caps page size and surfaces cursor_expired with scoped resync on gaps", async () => {
    const app = bootApp([
      row({ seq: 10, topic: "project:changed", subject_kind: "project", subject_id: "kapelle" }),
      row({ seq: 11, topic: "read_state:changed", subject_kind: "artifact", subject_id: "artifact-a" }),
    ]);

    const { status, body } = await getJson(app, "/read-model/events?since=0&limit=10000");

    expect(status).toBe(200);
    expect(body.limit).toBe(500);
    expect(body.cursor).toMatchObject({ since: 0, next: 11, expired: true, earliestAvailableSeq: 10 });
    expect(body.events[0]).toMatchObject({
      id: "cursor_expired:team-a:0:10",
      kind: "cursor_expired",
      invalidateKeys: [],
      resyncScopes: [{ type: "team", id: "team-a", reason: "event_log_retention_gap" }],
    });
    expect(body.events.slice(1).map((event: any) => event.kind)).toEqual(["project_changed", "read_state_changed"]);
  });

  it("rejects malformed cursors", async () => {
    const app = bootApp([]);
    const { status, body } = await getJson(app, "/read-model/events?since=abc");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_since");
  });
});
