// Server-side deterministic retrieval loop. Sits around runToolLoop and
// verifies that the model did "enough" retrieval work before it's allowed
// to give up with an "I don't have information on X"-shaped reply.
//
// Runs OUTSIDE the LLM: the gate + thresholds are enforced by code. If the
// model bails too early, the server injects a nudge user message and
// re-runs the model. Up to MAX_CYCLES attempts total.

import type { ToolCallLog } from './knowledge.js';

export const MIN_QUERIES = 3;
export const MIN_UNIQUE_ROOTS = 2;
export const MIN_DOCS_INSPECTED = 1;
export const MAX_RETRIEVAL_CYCLES = 4;

// Short list of English stopwords that would otherwise dominate stem output.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'but', 'with', 'from', 'that', 'this', 'have', 'has',
  'had', 'are', 'was', 'were', 'been', 'being', 'did', 'does', 'doing', 'what',
  'which', 'who', 'whom', 'whose', 'how', 'why', 'when', 'where', 'there',
  'here', 'them', 'they', 'their', 'our', 'you', 'your', 'yours', 'ours',
  'mine', 'his', 'her', 'hers', 'not', 'about', 'into', 'onto', 'some', 'any',
  'all', 'each', 'every', 'than', 'then', 'just', 'also', 'can', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'because',
  'while', 'over', 'under', 'between', 'through', 'above', 'below', 'into',
  'out', 'off', 'too', 'very', 'only', 'own', 'same', 'such', 'those', 'these',
  'its', 'itself', 'yourself', 'himself', 'herself', 'themselves', 'ourselves',
  'myself', 'yourselves',
]);

// Regex list matching "I don't know"-shaped replies. Intentionally generous:
// false positives trigger an extra retrieval cycle (cost bounded by
// MAX_RETRIEVAL_CYCLES), false negatives let a lazy IDK through. We'd rather
// occasionally double-check than let the model give up silently.
const IDK_PATTERNS: RegExp[] = [
  /\bi\s+(?:do\s*n['']?t|don['']?t)\s+(?:have|know|see|find)\b/i,
  /\bi\s+(?:do\s*n['']?t|don['']?t)\s+have\s+(?:any\s+)?(?:info|information|details|data|record|records|knowledge|context)\b/i,
  /\bno\s+(?:info|information|details|data|record|records|knowledge|reference|mention|match|matches|results?)\s+(?:on|about|for|regarding|in)\b/i,
  /\b(?:unable|not\s+able|cannot|can['']?t|couldn['']?t)\s+(?:find|locate|determine|identify)\b/i,
  /\b(?:there(?:['']s|\s+is)?\s+)?no\s+(?:mention|reference)\s+of\b/i,
  /\b(?:nothing|no\s+results?)\s+(?:in\s+)?(?:the\s+)?knowledge\s+base\b/i,
  /\bthe\s+knowledge\s+base\s+(?:does\s+not|doesn['']?t)\s+(?:contain|mention|cover|include)\b/i,
  /\bnot\s+(?:in|available\s+in|covered\s+(?:in|by))\s+(?:the\s+)?(?:public\s+)?knowledge\s+base\b/i,
  /\bi\s+(?:have|hold)\s+no\s+(?:info|information|data|record|records)\b/i,
  /\bno\s+(?:such\s+)?(?:info|information|data|record|records|documentation)\s+(?:is\s+)?(?:available|present|here)\b/i,
];

export function detectIdkReply(text: string): boolean {
  if (!text) return false;
  const sample = text.trim();
  if (!sample) return false;
  return IDK_PATTERNS.some((re) => re.test(sample));
}

// Extracts simple word-stems from a query or user question. Strategy:
// lowercase → split on non-alphanumeric → drop stopwords and length<=2 →
// take the first 5 chars of each remaining word. Fast, deterministic,
// good enough for "are these two queries asking the same thing?"
export function extractStems(text: string): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[_]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const stems: string[] = [];
  for (const t of tokens) {
    stems.push(t.slice(0, 5));
  }
  return stems;
}

// Extracts "interesting" nouns from the user's question for the nudge text.
// We don't actually POS-tag — we just strip stopwords and emit the rest.
// Deduped, length-capped, lowercased.
export function extractUserNouns(text: string, cap: number = 8): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text
    .toLowerCase()
    .replace(/[_]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export interface RetrievalState {
  queries: string[];                  // every search_knowledge query string
  uniqueRoots: Set<string>;           // distinct stem "signatures" per query
  docsInspected: number;              // successful read_knowledge calls
  searchesWithHits: number;           // search_knowledge calls that returned ≥1 hit
  cycles: number;
}

export interface RetrievalCycleTrace {
  cycle: number;
  query_count: number;
  unique_roots: number;
  docs_inspected: number;
  searches_with_hits: number;
  nudged: boolean;
  reply_preview: string;
}

export function makeRetrievalState(): RetrievalState {
  return {
    queries: [],
    uniqueRoots: new Set(),
    docsInspected: 0,
    searchesWithHits: 0,
    cycles: 0,
  };
}

export function ingestToolLogs(state: RetrievalState, logs: ToolCallLog[]): void {
  for (const log of logs) {
    if (log.name === 'search_knowledge' && typeof log.args.query === 'string') {
      const q = log.args.query;
      state.queries.push(q);
      const stemKey = extractStems(q).sort().join('|');
      if (stemKey) state.uniqueRoots.add(stemKey);
      if (log.ok && log.result_count > 0) state.searchesWithHits += 1;
    } else if (log.name === 'read_knowledge' && log.ok) {
      state.docsInspected += 1;
    }
  }
}

export interface ThresholdAssessment {
  met: boolean;
  reasons: string[];
}

export function assessThresholds(state: RetrievalState): ThresholdAssessment {
  const reasons: string[] = [];
  if (state.queries.length < MIN_QUERIES) {
    reasons.push(`query_count=${state.queries.length} < min=${MIN_QUERIES}`);
  }
  if (state.uniqueRoots.size < MIN_UNIQUE_ROOTS) {
    reasons.push(`unique_roots=${state.uniqueRoots.size} < min=${MIN_UNIQUE_ROOTS}`);
  }
  if (state.docsInspected < MIN_DOCS_INSPECTED && state.searchesWithHits > 0) {
    // Require min_docs only when searches actually surfaced hits. If every
    // search returned 0 results there's nothing to read, and we shouldn't
    // force the model to call read_knowledge on a non-existent file_id.
    reasons.push(`docs_inspected=${state.docsInspected} < min=${MIN_DOCS_INSPECTED} (despite ${state.searchesWithHits} searches with hits)`);
  }
  return { met: reasons.length === 0, reasons };
}

// Builds the server-side nudge message appended to the conversation when
// the model gives up too early. Lists what's missing from the thresholds
// and seeds candidate synonyms from the user's original question nouns.
export function buildNudgeMessage(
  state: RetrievalState,
  assessment: ThresholdAssessment,
  userMessage: string,
): string {
  const nouns = extractUserNouns(userMessage);
  const priorQueries = state.queries.slice(-5);
  const priorList = priorQueries.length > 0 ? priorQueries.map((q) => `"${q}"`).join(', ') : 'none';
  const synonymHint =
    nouns.length > 0
      ? `Consider synonyms, plural/singular variants, or related terms for: ${nouns.join(', ')}.`
      : 'Consider synonyms, plural/singular variants, or related terms for the nouns in the original question.';
  const missing = assessment.reasons.length > 0 ? assessment.reasons.join('; ') : 'unspecified';
  return (
    `<system-reminder>\n` +
    `Your retrieval attempt is incomplete. You've tried ${state.queries.length} search_knowledge call(s) ` +
    `with ${state.uniqueRoots.size} unique word-stem combination(s) and inspected ${state.docsInspected} document(s). ` +
    `Thresholds not met: ${missing}.\n` +
    `Prior queries: ${priorList}.\n` +
    `Try at least 2 more search_knowledge calls with different word stems. ${synonymHint} ` +
    `If a search returns hits, call read_knowledge on the most relevant file_id. ` +
    `Only report that information is unavailable after you have genuinely exhausted reasonable search variants.\n` +
    `</system-reminder>`
  );
}

// The "legit give-up" carve-out from the task spec: thresholds met AND
// every search returned 0 hits AND no docs were read. In that case the
// model's IDK reply is honest and we let it through even if the regex flags it.
export function isLegitGiveUp(state: RetrievalState): boolean {
  const { met } = assessThresholds(state);
  return met && state.searchesWithHits === 0 && state.docsInspected === 0;
}

export function snapshotState(state: RetrievalState): {
  query_count: number;
  unique_roots: number;
  docs_inspected: number;
  searches_with_hits: number;
  queries: string[];
} {
  return {
    query_count: state.queries.length,
    unique_roots: state.uniqueRoots.size,
    docs_inspected: state.docsInspected,
    searches_with_hits: state.searchesWithHits,
    queries: state.queries.slice(),
  };
}
