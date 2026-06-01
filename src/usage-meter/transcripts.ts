// Usage Meter — Claude Code transcript JSONL parser.
//
// Reads `~/.claude/projects/**/*.jsonl` assistant messages containing a
// `message.usage` block and emits structured `AgentUsageEvent` rows.
// Pure function: takes string content + a logical path identifier; the
// filesystem walk is done by a thin wrapper in service.ts.

import { createHash } from "node:crypto";

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * weighted_tokens = input + output + cache_creation + cache_read * 0.1
 * Rounded up to integer (so any non-zero cache_read counts).
 */
export function computeWeightedTokens(u: RawUsage): number {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const weighted = input + output + cacheCreate + cacheRead * 0.1;
  return Math.ceil(weighted);
}

export interface ParsedTranscriptEvent {
  /** Stable per-line id; combines path + line index + message uuid. */
  idempotency_key: string;
  model: string | null;
  session_id: string | null;
  message_uuid: string | null;
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  raw_tokens: number;
  weighted_tokens: number;
  source_path: string;
  source_line: number;
}

/**
 * Parse a single JSONL line. Returns null for any non-assistant or
 * malformed input; never throws.
 */
export function parseTranscriptLine(
  raw: string,
  sourcePath: string,
  lineIndex: number,
): ParsedTranscriptEvent | null {
  if (!raw || !raw.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "assistant") return null;
  const msg = obj.message;
  if (!msg || typeof msg !== "object") return null;
  const usage = msg.usage as RawUsage | undefined;
  if (!usage || typeof usage !== "object") return null;

  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  if (input + output + cacheCreate + cacheRead === 0) return null;

  const ts = obj.timestamp ? Date.parse(obj.timestamp) : Date.now();
  const session_id =
    typeof obj.session_id === "string" ? obj.session_id :
    typeof obj.sessionId === "string" ? obj.sessionId :
    null;
  const message_uuid =
    typeof obj.uuid === "string" ? obj.uuid :
    typeof msg.id === "string" ? msg.id :
    null;

  return {
    idempotency_key: computeIdempotencyKey(sourcePath, lineIndex, message_uuid),
    model: typeof msg.model === "string" ? msg.model : null,
    session_id,
    message_uuid,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    raw_tokens: input + output + cacheCreate + cacheRead,
    weighted_tokens: computeWeightedTokens(usage),
    source_path: sourcePath,
    source_line: lineIndex,
  };
}

export function parseTranscriptContent(
  content: string,
  sourcePath: string,
): ParsedTranscriptEvent[] {
  if (!content) return [];
  const lines = content.split("\n");
  const out: ParsedTranscriptEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ev = parseTranscriptLine(lines[i]!, sourcePath, i);
    if (ev) out.push(ev);
  }
  return out;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

function computeIdempotencyKey(
  sourcePath: string,
  lineIndex: number,
  messageUuid: string | null,
): string {
  const seed = `${sourcePath}:${lineIndex}:${messageUuid ?? ""}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
