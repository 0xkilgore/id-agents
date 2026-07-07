import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import {
  LOCAL_READ_MUTATION_SCHEMA_VERSION,
  buildLocalReadOutboxEntry,
  createInMemoryLocalReadMutationStore,
  mountLocalReadMutationRoutes,
  reconcileLocalReadOutboxEntry,
  type LocalReadMutationRecord,
  type LocalReadMutationRequest,
} from "../../src/local-search/index.js";

const ACTOR = { type: "user", id: "operator:kate" } as const;
const ENTITY = { type: "artifact", id: "artifact:fall-fest-rundown" } as const;
const UPDATED_BY = { type: "manager", id: "manager" } as const;

function seedRecord(overrides: Partial<LocalReadMutationRecord> = {}): LocalReadMutationRecord {
  return {
    team_id: "team-a",
    entity: ENTITY,
    readState: "unread",
    version: 7,
    updatedAt: "2026-07-07T16:00:00.000Z",
    updatedBy: UPDATED_BY,
    ...overrides,
  };
}

function mutation(overrides: Partial<LocalReadMutationRequest> = {}): LocalReadMutationRequest {
  return {
    schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
    actor: ACTOR,
    team_id: "team-a",
    entity: ENTITY,
    desiredReadState: "read",
    clientMutationId: "cmid-success-1",
    baseVersion: 7,
    ...overrides,
  };
}

function postJson(app: Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await response.json();
        server.close(() => resolve({ status: response.status, body: json }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function bootApp(seed: LocalReadMutationRecord[] = [seedRecord()]) {
  const app = express();
  app.use(express.json());
  const store = createInMemoryLocalReadMutationStore(seed, () => new Date("2026-07-07T17:00:00.000Z"));
  mountLocalReadMutationRoutes(app, store);
  return { app, store };
}

describe("local read/unread mutation ack contract", () => {
  it("acks a successful read-state mutation with durable outbox reconciliation fields", async () => {
    const { app } = bootApp();
    const input = mutation();
    const outbox = buildLocalReadOutboxEntry(input, new Date("2026-07-07T16:59:00.000Z"));

    const res = await postJson(app, "/read-model/read-state", input);
    const reconciled = reconcileLocalReadOutboxEntry(outbox, res.body, new Date("2026-07-07T17:01:00.000Z"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      schemaVersion: "read_model.read_state_mutation.v1",
      status: "acked",
      actor: ACTOR,
      team_id: "team-a",
      entity: ENTITY,
      desiredReadState: "read",
      clientMutationId: "cmid-success-1",
      baseVersion: 7,
      ackVersion: 8,
      conflict: null,
      failure: null,
    });
    expect(res.body.record).toMatchObject({ readState: "read", version: 8, updatedBy: ACTOR });
    expect(reconciled).toMatchObject({
      status: "acked",
      ackVersion: 8,
      clientMutationId: "cmid-success-1",
      lastAck: { status: "acked", ackVersion: 8 },
    });
  });

  it("returns a visible conflict when baseVersion is stale", async () => {
    const { app } = bootApp();
    const res = await postJson(app, "/read-model/read-state", mutation({
      clientMutationId: "cmid-conflict-1",
      baseVersion: 6,
    }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false,
      status: "conflict",
      clientMutationId: "cmid-conflict-1",
      baseVersion: 6,
      ackVersion: 7,
      record: { readState: "unread", version: 7 },
      conflict: {
        code: "stale_base_version",
        baseVersion: 6,
        currentVersion: 7,
        currentReadState: "unread",
      },
      failure: null,
    });
  });

  it("replays duplicate clientMutationId with the original ack", async () => {
    const { app, store } = bootApp();
    const first = await postJson(app, "/read-model/read-state", mutation({ clientMutationId: "cmid-replay-1" }));
    const replay = await postJson(app, "/read-model/read-state", mutation({
      clientMutationId: "cmid-replay-1",
      baseVersion: 7,
    }));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(store.get("team-a", ENTITY)).toMatchObject({ readState: "read", version: 8 });
  });

  it("isolates both records and clientMutationId replay by team_id", async () => {
    const { app, store } = bootApp([
      seedRecord({ team_id: "team-a", version: 7, readState: "unread" }),
      seedRecord({ team_id: "team-b", version: 3, readState: "unread" }),
    ]);

    const teamA = await postJson(app, "/read-model/read-state", mutation({ team_id: "team-a", clientMutationId: "same-cmid" }));
    const teamB = await postJson(app, "/read-model/read-state", mutation({
      team_id: "team-b",
      clientMutationId: "same-cmid",
      baseVersion: 3,
    }));

    expect(teamA.status).toBe(200);
    expect(teamB.status).toBe(200);
    expect(teamA.body.ackVersion).toBe(8);
    expect(teamB.body.ackVersion).toBe(4);
    expect(store.get("team-a", ENTITY)).toMatchObject({ readState: "read", version: 8 });
    expect(store.get("team-b", ENTITY)).toMatchObject({ readState: "read", version: 4 });
  });

  it("returns a visible failed ack for a missing entity", async () => {
    const { app } = bootApp([]);
    const res = await postJson(app, "/read-model/read-state", mutation({ clientMutationId: "cmid-missing-1" }));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      ok: false,
      status: "failed",
      ackVersion: null,
      record: null,
      conflict: null,
      failure: {
        code: "not_found",
        retryable: false,
      },
    });
  });
});
