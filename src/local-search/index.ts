export * from "./contract.js";
export * from "./read-mutation.js";

import {
  LOCAL_SEARCH_INDEX_SCHEMA_VERSION,
  LOCAL_SEARCH_SCHEMA_VERSION,
  type LocalSearchDocument,
  type LocalSearchEntityType,
  type LocalSearchFreshness,
  type LocalSearchHit,
  type LocalSearchIndexHealth,
  type LocalSearchIndexSnapshot,
  type LocalSearchQuery,
  type LocalSearchReadState,
  type LocalSearchResponse,
} from "./contract.js";
import {
  localHealthVisualForFreshness,
  localHealthVisualForIndex,
} from "./visual-state.js";

export const LOCAL_SEARCH_DEFAULT_LIMIT = 25;
export const LOCAL_SEARCH_MAX_LIMIT = 100;

const EMPTY_HEALTH: LocalSearchIndexHealth = {
  state: "ready",
  indexedAt: new Date(0).toISOString(),
  documentCount: 0,
};

export function createLocalSearchIndex(
  documents: LocalSearchDocument[],
  health: Partial<LocalSearchIndexHealth> = {},
): LocalSearchIndexSnapshot {
  return {
    schemaVersion: LOCAL_SEARCH_INDEX_SCHEMA_VERSION,
    documents,
    health: {
      ...EMPTY_HEALTH,
      ...health,
      documentCount: health.documentCount ?? documents.length,
    },
  };
}

export function parseLocalSearchTypes(raw: string | string[] | undefined): LocalSearchEntityType[] | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const allowed = new Set<LocalSearchEntityType>(["artifact", "project", "task"]);
  const types = value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is LocalSearchEntityType => allowed.has(part as LocalSearchEntityType));
  return types.length > 0 ? types : undefined;
}

export function parseLocalSearchBool(raw: string | string[] | undefined): boolean | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

export function searchLocalIndex(
  snapshot: LocalSearchIndexSnapshot,
  query: LocalSearchQuery,
  now = new Date(),
): LocalSearchResponse {
  const limit = Math.min(Math.max(query.limit ?? LOCAL_SEARCH_DEFAULT_LIMIT, 1), LOCAL_SEARCH_MAX_LIMIT);
  const offset = decodeCursor(query.cursor);
  const tokens = tokenize(query.q ?? "");
  const hits = snapshot.documents
    .filter((doc) => matchesFilters(doc, query))
    .map((doc) => scoreDocument(doc, tokens))
    .filter((scored) => tokens.length === 0 || scored.matchFields.length > 0 && scored.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));

  const page = hits.slice(offset, offset + limit);
  const index = {
    ...snapshot.health,
    documentCount: snapshot.health.documentCount ?? snapshot.documents.length,
  };
  return {
    ok: true,
    schemaVersion: LOCAL_SEARCH_SCHEMA_VERSION,
    indexSchemaVersion: LOCAL_SEARCH_INDEX_SCHEMA_VERSION,
    query: { ...query, limit },
    generatedAt: now.toISOString(),
    items: page,
    count: page.length,
    limit,
    nextCursor: offset + limit < hits.length ? encodeCursor(offset + limit) : null,
    index,
    index_visual_state: localHealthVisualForIndex(index),
  };
}

function matchesFilters(doc: LocalSearchDocument, query: LocalSearchQuery): boolean {
  if (query.types && !query.types.includes(doc.entityType)) return false;
  if (query.project && !sameToken(doc.project, query.project)) return false;
  if (query.task && !sameToken(doc.task, query.task)) return false;
  if (query.status && !sameToken(doc.status, query.status)) return false;
  if (query.readState && normalizeReadState(doc.readState) !== query.readState) return false;
  if (query.needsReview != null && Boolean(doc.needsReview) !== query.needsReview) return false;
  if (query.author && !sameToken(doc.author, query.author)) return false;
  if (query.agent && !sameToken(doc.agent, query.agent)) return false;
  if (query.freshness && normalizeFreshness(doc.freshness) !== query.freshness) return false;
  return true;
}

function scoreDocument(doc: LocalSearchDocument, tokens: string[]): LocalSearchHit {
  const flattened = flattenMatchFields(doc.matchFields);
  const haystack = `${doc.title} ${flattened.map((field) => field.value).join(" ")}`;
  const lowerHaystack = haystack.toLowerCase();
  const matchedFields = new Set<string>();
  let score = tokens.length === 0 ? 1 : 0;
  let matchedTokenCount = 0;

  for (const token of tokens) {
    let tokenScore = 0;
    if (doc.title.toLowerCase().includes(token)) {
      tokenScore += 12;
      matchedFields.add("title");
    }
    for (const field of flattened) {
      if (field.value.toLowerCase().includes(token)) {
        tokenScore += field.name === "body" || field.name === "bodyText" ? 4 : 6;
        matchedFields.add(field.name);
      }
    }
    if (lowerHaystack.includes(token)) {
      matchedTokenCount += 1;
      score += tokenScore;
    }
  }
  if (tokens.length > 0 && matchedTokenCount !== tokens.length) score = 0;

  const freshness = normalizeFreshness(doc.freshness);
  return {
    entityType: doc.entityType,
    id: doc.id,
    title: doc.title,
    project: doc.project ?? null,
    task: doc.task ?? null,
    agent: doc.agent ?? null,
    author: doc.author ?? null,
    status: doc.status ?? null,
    readState: normalizeReadState(doc.readState),
    updatedAt: doc.updatedAt,
    matchFields: [...matchedFields].sort(),
    snippet: makeSnippet(doc, tokens),
    freshness,
    local_visual_state: localHealthVisualForFreshness(freshness, doc.entityType),
    openTarget: doc.openTarget,
    routeMetadata: doc.routeMetadata,
    score,
  };
}

function makeSnippet(doc: LocalSearchDocument, tokens: string[]): string {
  const candidates = [{ name: "title", value: doc.title }, ...flattenMatchFields(doc.matchFields)];
  const firstMatch = tokens.length === 0
    ? candidates[0]
    : candidates.find((field) => tokens.some((token) => field.value.toLowerCase().includes(token)));
  const value = (firstMatch?.value ?? doc.title).replace(/\s+/g, " ").trim();
  if (value.length <= 180) return value;
  const lower = value.toLowerCase();
  const matchAt = tokens.length > 0 ? Math.max(0, lower.indexOf(tokens[0])) : 0;
  const start = Math.max(0, matchAt - 70);
  const end = Math.min(value.length, start + 180);
  return `${start > 0 ? "..." : ""}${value.slice(start, end)}${end < value.length ? "..." : ""}`;
}

function flattenMatchFields(fields: LocalSearchDocument["matchFields"]): { name: string; value: string }[] {
  const flattened: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const joined = value.map((part) => String(part)).join(" ");
      if (joined) flattened.push({ name, value: joined });
      continue;
    }
    flattened.push({ name, value: String(value) });
  }
  return flattened;
}

function tokenize(raw: string): string[] {
  return (raw.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((token) => token.toLowerCase());
}

function sameToken(left: string | null | undefined, right: string): boolean {
  return String(left ?? "").toLowerCase() === right.toLowerCase();
}

function normalizeReadState(value: LocalSearchReadState | null | undefined): LocalSearchReadState {
  return value ?? "unknown";
}

function normalizeFreshness(value: LocalSearchFreshness | null | undefined): LocalSearchFreshness {
  return value ?? "current";
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return Math.max(Number(decoded.offset ?? 0) || 0, 0);
  } catch {
    return 0;
  }
}
