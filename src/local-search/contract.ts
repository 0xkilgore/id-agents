export const LOCAL_SEARCH_SCHEMA_VERSION = "read_model.search.v1" as const;
export const LOCAL_SEARCH_INDEX_SCHEMA_VERSION = "local_search.index.v0" as const;

export type LocalSearchEntityType = "artifact" | "project" | "task";
export type LocalSearchReadState = "read" | "unread" | "read_but_has_new_activity" | "unknown";
export type LocalSearchFreshness = "current" | "syncing" | "stale" | "event_gap" | "mutation_failed" | "error";
export type LocalSearchIndexHealthState = "ready" | "indexing" | "stale" | "index_partial" | "error";

export interface LocalSearchOpenTarget {
  kind: "artifact" | "project" | "task" | "dispatch";
  href?: string;
  route?: string;
  ref: string;
}

export interface LocalSearchDocument {
  entityType: LocalSearchEntityType;
  id: string;
  title: string;
  project?: string | null;
  task?: string | null;
  agent?: string | null;
  author?: string | null;
  status?: string | null;
  readState?: LocalSearchReadState | null;
  needsReview?: boolean;
  updatedAt: string;
  matchFields: Record<string, string | string[] | number | boolean | null | undefined>;
  freshness?: LocalSearchFreshness;
  openTarget: LocalSearchOpenTarget;
}

export interface LocalSearchIndexHealth {
  state: LocalSearchIndexHealthState;
  indexedAt: string;
  documentCount: number;
  staleReason?: string;
  partialScopes?: LocalSearchEntityType[];
  errors?: string[];
}

export interface LocalSearchQuery {
  q?: string;
  types?: LocalSearchEntityType[];
  project?: string;
  task?: string;
  status?: string;
  readState?: LocalSearchReadState;
  needsReview?: boolean;
  author?: string;
  agent?: string;
  freshness?: LocalSearchFreshness;
  limit?: number;
  cursor?: string;
}

export interface LocalSearchHit {
  entityType: LocalSearchEntityType;
  id: string;
  title: string;
  project: string | null;
  task: string | null;
  agent: string | null;
  author: string | null;
  status: string | null;
  readState: LocalSearchReadState;
  updatedAt: string;
  matchFields: string[];
  snippet: string;
  freshness: LocalSearchFreshness;
  openTarget: LocalSearchOpenTarget;
  score: number;
}

export interface LocalSearchResponse {
  ok: true;
  schemaVersion: typeof LOCAL_SEARCH_SCHEMA_VERSION;
  indexSchemaVersion: typeof LOCAL_SEARCH_INDEX_SCHEMA_VERSION;
  query: LocalSearchQuery;
  generatedAt: string;
  items: LocalSearchHit[];
  count: number;
  limit: number;
  nextCursor: string | null;
  index: LocalSearchIndexHealth;
}

export interface LocalSearchIndexSnapshot {
  schemaVersion: typeof LOCAL_SEARCH_INDEX_SCHEMA_VERSION;
  documents: LocalSearchDocument[];
  health: LocalSearchIndexHealth;
}
