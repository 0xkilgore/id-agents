import type { Application, Request, Response } from "express";
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
