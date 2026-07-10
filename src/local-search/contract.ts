import type { LocalHealthVisual } from "./visual-state.js";

export const LOCAL_SEARCH_SCHEMA_VERSION = "read_model.search.v1" as const;
export const LOCAL_SEARCH_INDEX_SCHEMA_VERSION = "local_search.index.v0" as const;

export type LocalSearchEntityType = "artifact" | "project" | "task" | "source";
export type LocalSearchReadState = "read" | "unread" | "read_but_has_new_activity" | "unknown";
export type LocalSearchFreshness = "current" | "syncing" | "stale" | "event_gap" | "mutation_failed" | "error";
export type LocalSearchIndexHealthState = "ready" | "indexing" | "stale" | "index_partial" | "error";
export type LocalSearchSourceType = "transcript" | "image" | "pdf" | "email" | "artifact" | "other";
export type LocalSearchBodySource = "cache" | "filesystem" | "unavailable";
export type {
  LocalHealthVisual,
  LocalHealthVisualState,
  LocalHealthVisualTone,
} from "./visual-state.js";

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
  track?: string | null;
  task?: string | null;
  agent?: string | null;
  author?: string | null;
  status?: string | null;
  readState?: LocalSearchReadState | null;
  needsReview?: boolean;
  createdAt?: string;
  updatedAt: string;
  matchFields: Record<string, string | string[] | number | boolean | null | undefined>;
  freshness?: LocalSearchFreshness;
  openTarget: LocalSearchOpenTarget;
  routeMetadata?: LocalSearchRouteMetadata;
}

export interface LocalSearchRouteMetadata {
  sourceType?: LocalSearchSourceType;
  sourcePath?: string | null;
  sourceProof?: string | null;
  linkedArtifact?: string | null;
  linkedDispatch?: string | null;
  stableUrl?: string | null;
  copyTextUrl?: string | null;
  downloadUrl?: string | null;
  bodyAvailable?: boolean;
  bodyCached?: boolean;
  bodySource?: LocalSearchBodySource;
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
  track?: string;
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
  rank: number;
  resultDomId: string;
  title: string;
  project: string | null;
  track: string | null;
  task: string | null;
  agent: string | null;
  author: string | null;
  status: string | null;
  readState: LocalSearchReadState;
  updatedAt: string;
  matchFields: string[];
  snippet: string;
  snippet_highlights: LocalSearchSnippetHighlight[];
  freshness: LocalSearchFreshness;
  local_visual_state: LocalHealthVisual;
  openTarget: LocalSearchOpenTarget;
  routeMetadata?: LocalSearchRouteMetadata;
  score: number;
}

export interface LocalSearchSnippetHighlight {
  field: string;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface LocalSearchResultUx {
  rankedList: true;
  keyboardNavigation: {
    role: "listbox";
    itemRole: "option";
    orientation: "vertical";
    activeDescendantPattern: "local-search-result-{rank}";
  };
  scopeControls: Array<"project" | "track" | "agent" | "type" | "read_state" | "needs_review">;
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
  index_visual_state: LocalHealthVisual;
  ux: LocalSearchResultUx;
}

export interface LocalSearchIndexSnapshot {
  schemaVersion: typeof LOCAL_SEARCH_INDEX_SCHEMA_VERSION;
  documents: LocalSearchDocument[];
  health: LocalSearchIndexHealth;
}
