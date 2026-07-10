import type { Application, Request, Response } from "express";
import type { EventsRepository } from "../db/db-service.js";
import type { EventLogRow } from "../db/types.js";

export const LOCAL_READ_EVENTS_SCHEMA_VERSION = "read_model.events.v0" as const;
export const LOCAL_READ_EVENTS_DEFAULT_LIMIT = 100;
export const LOCAL_READ_EVENTS_MAX_LIMIT = 500;

export type LocalReadEventKind =
  | "artifact_metadata_changed"
  | "artifact_body_changed"
  | "comment_timeline_changed"
  | "read_state_changed"
  | "task_changed"
  | "project_changed"
  | "cursor_expired";

export type LocalReadEntityType = "artifact" | "project" | "task" | "dispatch" | "comment";

export interface LocalReadEntityRef {
  type: LocalReadEntityType;
  id: string;
}

export interface LocalReadResyncScope {
  type: "artifact" | "project" | "task" | "team";
  id: string;
  reason: string;
}

export interface LocalReadEvent {
  id: string;
  seq: number;
  kind: LocalReadEventKind;
  topic: string;
  occurredAt: string;
  entity: LocalReadEntityRef | null;
  invalidateKeys: string[];
  resyncScopes: LocalReadResyncScope[];
  sourceEventId: string;
}

export interface LocalReadEventsResponse {
  ok: true;
  schemaVersion: typeof LOCAL_READ_EVENTS_SCHEMA_VERSION;
  cursor: {
    since: number;
    next: number;
    earliestAvailableSeq: number | null;
    expired: boolean;
  };
  events: LocalReadEvent[];
  limit: number;
}

export interface LocalReadEventRouteDeps {
  events: EventsRepository;
  resolveTeam(req: Request): Promise<{ id: string; name: string }>;
}

const LOCAL_READ_EVENT_TOPICS = [
  "artifact:metadata_changed",
  "artifact:metadata:changed",
  "artifact:body_changed",
  "artifact:body:changed",
  "artifact:comment_changed",
  "artifact:comment:changed",
  "artifact:timeline_changed",
  "artifact:timeline:changed",
  "read_state:changed",
  "task:created",
  "task:updated",
  "task:claimed",
  "task:completed",
  "task:status",
  "project:changed",
  "project:updated",
] as const;

export function mountLocalReadEventRoutes(app: Application, deps: LocalReadEventRouteDeps): void {
  app.get("/read-model/events", async (req: Request, res: Response) => {
    try {
      const team = await deps.resolveTeam(req);
      const since = parseNonNegativeInteger(req.query.since, "since", 0);
      const limit = parsePositiveInteger(req.query.limit, "limit", LOCAL_READ_EVENTS_DEFAULT_LIMIT);
      const boundedLimit = Math.min(limit, LOCAL_READ_EVENTS_MAX_LIMIT);

      const [rows, earliestAvailableSeq] = await Promise.all([
        deps.events.query({
          teamId: team.id,
          sinceSeq: since,
          topics: [...LOCAL_READ_EVENT_TOPICS],
          limit: boundedLimit,
        }),
        deps.events.earliestSeq(team.id),
      ]);

      const expired = earliestAvailableSeq !== null && since + 1 < earliestAvailableSeq;
      const events = rows.map((row) => localReadEventFromRow(row)).filter((event): event is LocalReadEvent => event !== null);
      if (expired) {
        events.unshift(cursorExpiredEvent({ teamName: team.name, since, earliestAvailableSeq }));
      }

      const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : since;
      const body: LocalReadEventsResponse = {
        ok: true,
        schemaVersion: LOCAL_READ_EVENTS_SCHEMA_VERSION,
        cursor: {
          since,
          next: lastSeq,
          earliestAvailableSeq,
          expired,
        },
        events,
        limit: boundedLimit,
      };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "invalid_since" || message === "invalid_limit") {
        res.status(400).json({ ok: false, error: message });
        return;
      }
      res.status(500).json({ ok: false, error: message });
    }
  });
}

export function localReadEventFromRow(row: EventLogRow): LocalReadEvent | null {
  const entity = entityFromRow(row);
  const sourceEventId = `event_log:${row.seq}`;
  const base = {
    id: sourceEventId,
    seq: row.seq,
    topic: row.topic,
    occurredAt: new Date(row.occurred_at).toISOString(),
    entity,
    sourceEventId,
  };

  if (row.topic === "artifact:metadata_changed" || row.topic === "artifact:metadata:changed") {
    return {
      ...base,
      kind: "artifact_metadata_changed",
      invalidateKeys: artifactKeys(entity?.id),
      resyncScopes: entity ? [{ type: "artifact", id: entity.id, reason: "artifact_metadata_changed" }] : [],
    };
  }

  if (row.topic === "artifact:body_changed" || row.topic === "artifact:body:changed") {
    return {
      ...base,
      kind: "artifact_body_changed",
      invalidateKeys: artifactKeys(entity?.id),
      resyncScopes: entity ? [{ type: "artifact", id: entity.id, reason: "artifact_body_changed" }] : [],
    };
  }

  if (
    row.topic === "artifact:comment_changed" ||
    row.topic === "artifact:comment:changed" ||
    row.topic === "artifact:timeline_changed" ||
    row.topic === "artifact:timeline:changed"
  ) {
    const artifactId = stringData(row, "artifact_id") ?? (entity?.type === "artifact" ? entity.id : null);
    return {
      ...base,
      kind: "comment_timeline_changed",
      entity: artifactId ? { type: "artifact", id: artifactId } : entity,
      invalidateKeys: artifactId ? artifactKeys(artifactId) : entityKeys(entity),
      resyncScopes: artifactId ? [{ type: "artifact", id: artifactId, reason: "comment_timeline_changed" }] : [],
    };
  }

  if (row.topic === "read_state:changed") {
    return {
      ...base,
      kind: "read_state_changed",
      invalidateKeys: entityKeys(entity),
      resyncScopes: entity ? [{ type: entity.type === "project" ? "project" : entity.type === "task" ? "task" : "artifact", id: entity.id, reason: "read_state_changed" }] : [],
    };
  }

  if (row.topic.startsWith("task:")) {
    return {
      ...base,
      kind: "task_changed",
      invalidateKeys: entityKeys(entity),
      resyncScopes: entity ? [{ type: "task", id: entity.id, reason: row.topic }] : [],
    };
  }

  if (row.topic === "project:changed" || row.topic === "project:updated") {
    return {
      ...base,
      kind: "project_changed",
      invalidateKeys: entityKeys(entity),
      resyncScopes: entity ? [{ type: "project", id: entity.id, reason: row.topic }] : [],
    };
  }

  return null;
}

function cursorExpiredEvent(input: { teamName: string; since: number; earliestAvailableSeq: number }): LocalReadEvent {
  return {
    id: `cursor_expired:${input.teamName}:${input.since}:${input.earliestAvailableSeq}`,
    seq: input.earliestAvailableSeq - 1,
    kind: "cursor_expired",
    topic: "cursor_expired",
    occurredAt: new Date(0).toISOString(),
    entity: null,
    invalidateKeys: [],
    resyncScopes: [{ type: "team", id: input.teamName, reason: "event_log_retention_gap" }],
    sourceEventId: `cursor_expired:${input.since}:${input.earliestAvailableSeq}`,
  };
}

function entityFromRow(row: EventLogRow): LocalReadEntityRef | null {
  const dataEntity = row.data.entity;
  if (dataEntity && typeof dataEntity === "object") {
    const maybe = dataEntity as { type?: unknown; id?: unknown };
    if (isEntityType(maybe.type) && typeof maybe.id === "string" && maybe.id.length > 0) {
      return { type: maybe.type, id: maybe.id };
    }
  }

  if (row.subject_kind === "artifact" && row.subject_id) return { type: "artifact", id: row.subject_id };
  if (row.subject_kind === "project" && row.subject_id) return { type: "project", id: row.subject_id };
  if (row.subject_kind === "task" && row.subject_id) {
    return { type: "task", id: stringData(row, "task_name") ?? stringData(row, "task_uuid") ?? row.subject_id };
  }
  if (row.subject_kind === "dispatch" && row.subject_id) return { type: "dispatch", id: row.subject_id };
  if (row.subject_kind === "comment" && row.subject_id) return { type: "comment", id: row.subject_id };
  return null;
}

function artifactKeys(id: string | undefined): string[] {
  if (!id) return [];
  return [`artifact:${id}`, `artifact:${id}:detail`, `artifact:${id}:body`, `artifact:${id}:timeline`];
}

function entityKeys(entity: LocalReadEntityRef | null): string[] {
  if (!entity) return [];
  return [`${entity.type}:${entity.id}`];
}

function stringData(row: EventLogRow, key: string): string | null {
  const value = row.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isEntityType(value: unknown): value is LocalReadEntityType {
  return value === "artifact" || value === "project" || value === "task" || value === "dispatch" || value === "comment";
}

function parseNonNegativeInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
  return parsed;
}

function parsePositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid_${name}`);
  return parsed;
}
