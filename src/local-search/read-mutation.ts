import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import type { LocalSearchReadState } from "./contract.js";

export const LOCAL_READ_MUTATION_SCHEMA_VERSION = "read_model.read_state_mutation.v1" as const;

export type LocalReadMutationDesiredState = Extract<LocalSearchReadState, "read" | "unread">;
export type LocalReadMutationAckStatus = "acked" | "conflict" | "failed";

export interface LocalReadMutationActor {
  type: "user" | "agent" | "manager";
  id: string;
}

export interface LocalReadMutationEntity {
  type: "artifact" | "project" | "task" | "dispatch";
  id: string;
}

export interface LocalReadMutationRequest {
  schemaVersion?: typeof LOCAL_READ_MUTATION_SCHEMA_VERSION;
  actor: LocalReadMutationActor;
  team_id: string;
  entity: LocalReadMutationEntity;
  desiredReadState: LocalReadMutationDesiredState;
  clientMutationId: string;
  baseVersion: number;
}

export interface LocalReadMutationRecord {
  team_id: string;
  entity: LocalReadMutationEntity;
  readState: LocalReadMutationDesiredState;
  version: number;
  updatedAt: string;
  updatedBy: LocalReadMutationActor;
}

export interface LocalReadMutationConflict {
  code: "stale_base_version";
  message: string;
  baseVersion: number;
  currentVersion: number;
  currentReadState: LocalReadMutationDesiredState;
}

export interface LocalReadMutationFailure {
  code: "invalid_request" | "not_found" | "store_error";
  message: string;
  retryable: boolean;
}

export interface LocalReadMutationAck {
  ok: boolean;
  schemaVersion: typeof LOCAL_READ_MUTATION_SCHEMA_VERSION;
  status: LocalReadMutationAckStatus;
  actor: LocalReadMutationActor;
  team_id: string;
  entity: LocalReadMutationEntity;
  desiredReadState: LocalReadMutationDesiredState;
  clientMutationId: string;
  baseVersion: number;
  ackVersion: number | null;
  record: LocalReadMutationRecord | null;
  conflict: LocalReadMutationConflict | null;
  failure: LocalReadMutationFailure | null;
}

export interface LocalReadMutationStore {
  applyReadMutation(input: LocalReadMutationRequest): Promise<LocalReadMutationAck>;
}

export interface LocalReadMutationOutboxEntry {
  schemaVersion: typeof LOCAL_READ_MUTATION_SCHEMA_VERSION;
  actor: LocalReadMutationActor;
  team_id: string;
  entity: LocalReadMutationEntity;
  desiredReadState: LocalReadMutationDesiredState;
  clientMutationId: string;
  baseVersion: number;
  status: "pending" | LocalReadMutationAckStatus;
  ackVersion: number | null;
  lastAck: LocalReadMutationAck | null;
  createdAt: string;
  updatedAt: string;
}

export function buildLocalReadOutboxEntry(
  input: LocalReadMutationRequest,
  now = new Date(),
): LocalReadMutationOutboxEntry {
  assertValidLocalReadMutation(input);
  const iso = now.toISOString();
  return {
    schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
    actor: input.actor,
    team_id: input.team_id,
    entity: input.entity,
    desiredReadState: input.desiredReadState,
    clientMutationId: input.clientMutationId,
    baseVersion: input.baseVersion,
    status: "pending",
    ackVersion: null,
    lastAck: null,
    createdAt: iso,
    updatedAt: iso,
  };
}

export function reconcileLocalReadOutboxEntry(
  entry: LocalReadMutationOutboxEntry,
  ack: LocalReadMutationAck,
  now = new Date(),
): LocalReadMutationOutboxEntry {
  if (entry.clientMutationId !== ack.clientMutationId || entry.team_id !== ack.team_id) {
    throw new Error("ack does not match outbox entry");
  }
  return {
    ...entry,
    status: ack.status,
    ackVersion: ack.ackVersion,
    lastAck: ack,
    updatedAt: now.toISOString(),
  };
}

export function createInMemoryLocalReadMutationStore(
  seed: LocalReadMutationRecord[] = [],
  now: () => Date = () => new Date(),
): LocalReadMutationStore & { get(team_id: string, entity: LocalReadMutationEntity): LocalReadMutationRecord | null } {
  const records = new Map<string, LocalReadMutationRecord>();
  const acks = new Map<string, LocalReadMutationAck>();
  for (const record of seed) records.set(recordKey(record.team_id, record.entity), { ...record });

  return {
    get(team_id: string, entity: LocalReadMutationEntity) {
      return records.get(recordKey(team_id, entity)) ?? null;
    },
    async applyReadMutation(input: LocalReadMutationRequest): Promise<LocalReadMutationAck> {
      assertValidLocalReadMutation(input);
      const mutationKey = replayKey(input);
      const replay = acks.get(mutationKey);
      if (replay) return replay;

      const key = recordKey(input.team_id, input.entity);
      const current = records.get(key);
      if (!current) {
        const ack = failedAck(input, {
          code: "not_found",
          message: `read-state entity not found: ${input.entity.type}:${input.entity.id}`,
          retryable: false,
        });
        acks.set(mutationKey, ack);
        return ack;
      }

      if (current.version !== input.baseVersion) {
        const ack = conflictAck(input, current);
        acks.set(mutationKey, ack);
        return ack;
      }

      const next: LocalReadMutationRecord = {
        ...current,
        readState: input.desiredReadState,
        version: current.version + 1,
        updatedAt: now().toISOString(),
        updatedBy: input.actor,
      };
      records.set(key, next);
      const ack = acked(input, next);
      acks.set(mutationKey, ack);
      return ack;
    },
  };
}

export async function migrateLocalReadMutationTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS local_read_state (
      team_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      read_state TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_type TEXT NOT NULL,
      updated_by_id TEXT NOT NULL,
      PRIMARY KEY (team_id, entity_type, entity_id)
    )
  `);
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS local_read_mutation_acks (
      team_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL,
      ack_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, actor_type, actor_id, client_mutation_id)
    )
  `);
  await adapter.query(`
    CREATE INDEX IF NOT EXISTS local_read_state_entity_idx
      ON local_read_state(team_id, entity_type, entity_id, version)
  `);
}

export function createSqliteLocalReadMutationStore(
  adapter: DbAdapter,
  now: () => Date = () => new Date(),
): LocalReadMutationStore & { get(team_id: string, entity: LocalReadMutationEntity): Promise<LocalReadMutationRecord | null> } {
  return {
    async get(team_id: string, entity: LocalReadMutationEntity) {
      return getDurableRecord(adapter, team_id, entity);
    },
    async applyReadMutation(input: LocalReadMutationRequest): Promise<LocalReadMutationAck> {
      assertValidLocalReadMutation(input);
      const replay = await getDurableAck(adapter, input);
      if (replay) return replay;

      let current = await getDurableRecord(adapter, input.team_id, input.entity);
      if (!current) {
        const exists = await durableEntityExists(adapter, input.team_id, input.entity);
        if (!exists) {
          const ack = failedAck(input, {
            code: "not_found",
            message: `read-state entity not found: ${input.entity.type}:${input.entity.id}`,
            retryable: false,
          });
          await saveDurableAck(adapter, input, ack, now);
          return ack;
        }
        current = {
          team_id: input.team_id,
          entity: input.entity,
          readState: "unread",
          version: 0,
          updatedAt: now().toISOString(),
          updatedBy: { type: "manager", id: "local-read-state" },
        };
        await insertDurableRecord(adapter, current);
      }

      if (current.version !== input.baseVersion) {
        const ack = conflictAck(input, current);
        await saveDurableAck(adapter, input, ack, now);
        return ack;
      }

      const next: LocalReadMutationRecord = {
        ...current,
        readState: input.desiredReadState,
        version: current.version + 1,
        updatedAt: now().toISOString(),
        updatedBy: input.actor,
      };
      await adapter.query(
        `UPDATE local_read_state
            SET read_state = ?, version = ?, updated_at = ?, updated_by_type = ?, updated_by_id = ?
          WHERE team_id = ? AND entity_type = ? AND entity_id = ? AND version = ?`,
        [
          next.readState,
          next.version,
          next.updatedAt,
          next.updatedBy.type,
          next.updatedBy.id,
          input.team_id,
          input.entity.type,
          input.entity.id,
          current.version,
        ],
      );
      const ack = acked(input, next);
      await emitReadStateChanged(adapter, input, next);
      await saveDurableAck(adapter, input, ack, now);
      return ack;
    },
  };
}

export function mountLocalReadMutationRoutes(app: Application, store: LocalReadMutationStore): void {
  app.post("/read-model/read-state", async (req: Request, res: Response) => {
    try {
      const input = req.body as LocalReadMutationRequest;
      assertValidLocalReadMutation(input);
      const ack = await store.applyReadMutation(input);
      res.status(ack.ok ? 200 : ack.status === "conflict" ? 409 : 422).json(ack);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({
        ok: false,
        schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
        status: "failed",
        ackVersion: null,
        record: null,
        conflict: null,
        failure: { code: "invalid_request", message, retryable: false },
      });
    }
  });
}

export function assertValidLocalReadMutation(input: LocalReadMutationRequest): void {
  if (!input || typeof input !== "object") throw new Error("request body is required");
  if (!input.team_id || typeof input.team_id !== "string") throw new Error("team_id is required");
  if (!input.actor || !input.actor.id || !input.actor.type) throw new Error("actor is required");
  if (!["user", "agent", "manager"].includes(input.actor.type)) throw new Error("actor.type is invalid");
  if (!input.entity || !input.entity.id || !input.entity.type) throw new Error("entity is required");
  if (!["artifact", "project", "task", "dispatch"].includes(input.entity.type)) throw new Error("entity.type is invalid");
  if (input.desiredReadState !== "read" && input.desiredReadState !== "unread") {
    throw new Error("desiredReadState must be read or unread");
  }
  if (!input.clientMutationId || typeof input.clientMutationId !== "string") {
    throw new Error("clientMutationId is required");
  }
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    throw new Error("baseVersion must be a non-negative integer");
  }
}

function acked(input: LocalReadMutationRequest, record: LocalReadMutationRecord): LocalReadMutationAck {
  return {
    ok: true,
    schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
    status: "acked",
    actor: input.actor,
    team_id: input.team_id,
    entity: input.entity,
    desiredReadState: input.desiredReadState,
    clientMutationId: input.clientMutationId,
    baseVersion: input.baseVersion,
    ackVersion: record.version,
    record,
    conflict: null,
    failure: null,
  };
}

function conflictAck(input: LocalReadMutationRequest, current: LocalReadMutationRecord): LocalReadMutationAck {
  return {
    ok: false,
    schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
    status: "conflict",
    actor: input.actor,
    team_id: input.team_id,
    entity: input.entity,
    desiredReadState: input.desiredReadState,
    clientMutationId: input.clientMutationId,
    baseVersion: input.baseVersion,
    ackVersion: current.version,
    record: current,
    conflict: {
      code: "stale_base_version",
      message: `baseVersion ${input.baseVersion} is stale; current version is ${current.version}`,
      baseVersion: input.baseVersion,
      currentVersion: current.version,
      currentReadState: current.readState,
    },
    failure: null,
  };
}

function failedAck(input: LocalReadMutationRequest, failure: LocalReadMutationFailure): LocalReadMutationAck {
  return {
    ok: false,
    schemaVersion: LOCAL_READ_MUTATION_SCHEMA_VERSION,
    status: "failed",
    actor: input.actor,
    team_id: input.team_id,
    entity: input.entity,
    desiredReadState: input.desiredReadState,
    clientMutationId: input.clientMutationId,
    baseVersion: input.baseVersion,
    ackVersion: null,
    record: null,
    conflict: null,
    failure,
  };
}

function recordKey(team_id: string, entity: LocalReadMutationEntity): string {
  return `${team_id}:${entity.type}:${entity.id}`;
}

function replayKey(input: LocalReadMutationRequest): string {
  return `${input.team_id}:${input.actor.type}:${input.actor.id}:${input.clientMutationId}`;
}

async function getDurableRecord(
  adapter: DbAdapter,
  team_id: string,
  entity: LocalReadMutationEntity,
): Promise<LocalReadMutationRecord | null> {
  const { rows } = await adapter.query<{
    team_id: string;
    entity_type: LocalReadMutationEntity["type"];
    entity_id: string;
    read_state: LocalReadMutationDesiredState;
    version: number;
    updated_at: string;
    updated_by_type: LocalReadMutationActor["type"];
    updated_by_id: string;
  }>(
    `SELECT team_id, entity_type, entity_id, read_state, version, updated_at, updated_by_type, updated_by_id
       FROM local_read_state
      WHERE team_id = ? AND entity_type = ? AND entity_id = ?`,
    [team_id, entity.type, entity.id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    team_id: row.team_id,
    entity: { type: row.entity_type, id: row.entity_id },
    readState: row.read_state,
    version: Number(row.version),
    updatedAt: row.updated_at,
    updatedBy: { type: row.updated_by_type, id: row.updated_by_id },
  };
}

async function insertDurableRecord(adapter: DbAdapter, record: LocalReadMutationRecord): Promise<void> {
  await adapter.query(
    `INSERT INTO local_read_state
       (team_id, entity_type, entity_id, read_state, version, updated_at, updated_by_type, updated_by_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.team_id,
      record.entity.type,
      record.entity.id,
      record.readState,
      record.version,
      record.updatedAt,
      record.updatedBy.type,
      record.updatedBy.id,
    ],
  );
}

async function getDurableAck(adapter: DbAdapter, input: LocalReadMutationRequest): Promise<LocalReadMutationAck | null> {
  const { rows } = await adapter.query<{ ack_json: string }>(
    `SELECT ack_json
       FROM local_read_mutation_acks
      WHERE team_id = ? AND actor_type = ? AND actor_id = ? AND client_mutation_id = ?`,
    [input.team_id, input.actor.type, input.actor.id, input.clientMutationId],
  );
  if (!rows[0]) return null;
  return JSON.parse(rows[0].ack_json) as LocalReadMutationAck;
}

async function saveDurableAck(
  adapter: DbAdapter,
  input: LocalReadMutationRequest,
  ack: LocalReadMutationAck,
  now: () => Date,
): Promise<void> {
  await adapter.query(
    `INSERT INTO local_read_mutation_acks
       (team_id, actor_type, actor_id, client_mutation_id, ack_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, actor_type, actor_id, client_mutation_id) DO NOTHING`,
    [
      input.team_id,
      input.actor.type,
      input.actor.id,
      input.clientMutationId,
      JSON.stringify(ack),
      now().toISOString(),
    ],
  );
}

async function emitReadStateChanged(
  adapter: DbAdapter,
  input: LocalReadMutationRequest,
  record: LocalReadMutationRecord,
): Promise<void> {
  await adapter.query(
    `INSERT INTO event_log
       (team_id, topic, actor_agent_id, subject_kind, subject_id, occurred_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.team_id,
      "read_state:changed",
      input.actor.type === "agent" ? input.actor.id : null,
      input.entity.type,
      input.entity.id,
      Date.parse(record.updatedAt),
      JSON.stringify({
        entity: input.entity,
        read_state: record.readState,
        version: record.version,
        client_mutation_id: input.clientMutationId,
        updated_by: input.actor,
      }),
    ],
  );
}

async function durableEntityExists(
  adapter: DbAdapter,
  team_id: string,
  entity: LocalReadMutationEntity,
): Promise<boolean> {
  try {
    if (entity.type === "artifact") {
      const { rows } = await adapter.query<{ one: number }>(
        `SELECT 1 AS one FROM artifacts WHERE artifact_id = ? LIMIT 1`,
        [entity.id],
      );
      return Boolean(rows[0]);
    }
    if (entity.type === "project") {
      const { rows } = await adapter.query<{ one: number }>(
        `SELECT 1 AS one FROM teams WHERE id = ? OR name = ? LIMIT 1`,
        [entity.id, entity.id],
      );
      return Boolean(rows[0]);
    }
    if (entity.type === "task") {
      const { rows } = await adapter.query<{ one: number }>(
        `SELECT 1 AS one
           FROM tasks
          WHERE team_id = ? AND (id = ? OR uuid = ? OR name = ?)
          LIMIT 1`,
        [team_id, entity.id, entity.id, entity.id],
      );
      return Boolean(rows[0]);
    }
    const { rows } = await adapter.query<{ one: number }>(
      `SELECT 1 AS one
         FROM dispatch_scheduler_queue
        WHERE team_id = ? AND dispatch_phid = ?
        LIMIT 1`,
      [team_id, entity.id],
    );
    return Boolean(rows[0]);
  } catch {
    return false;
  }
}
