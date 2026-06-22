// Usage Meter — Claude Code transcript ingest.
//
// Closes the gap where the meter rendered but recorded nothing: walks the
// Claude Code transcript tree (`~/.claude/projects/**/*.jsonl`), parses the
// per-message `usage` blocks (transcripts.ts), attributes each event to an
// agent (attribution.ts), and writes idempotent `agent_usage_event` rows
// (storage.ts) — the rows GET /usage/daily-report aggregates. Best-effort:
// per-file/per-event failures are counted, never thrown.
//
// Source of truth: the agent runtime (claude-code-cli / claude-agent-sdk)
// writes real input/output/cache token counts into these transcripts; this
// job is the manager-local reader. NOTE: codex / cursor runtimes do NOT write
// under ~/.claude/projects, so their usage is not captured here (see the
// closeout for the proposed proxy).

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DbAdapter } from "../db/db-adapter.js";
import { upsertAgentUsageEvent } from "./storage.js";
import { parseTranscriptContent, type ParsedTranscriptEvent } from "./transcripts.js";
import {
  attributeEvent,
  type AttributionContext,
  type AttributionResult,
  type DispatchAttribution,
} from "./attribution.js";
import type { AgentUsageEvent, Provider } from "./types.js";

export interface IngestOptions {
  /** Defaults to `~/.claude/projects`. */
  transcriptsDir?: string;
  /** Only ingest files modified within this many days. Default 9 (covers the week window + slack). */
  lookbackDays?: number;
  now?: () => number;
  /** Provider lane for these events. Claude transcripts => "anthropic". */
  provider?: Provider;
}

export interface IngestTranscriptsResult {
  files_scanned: number;
  events_parsed: number;
  inserted: number;
  skipped_idempotent: number;
  errors: number;
  /** weighted_tokens newly inserted this run, per agent. */
  by_agent: Record<string, number>;
}

/** Pure: map a parsed transcript event + its attribution to a storable usage event. */
export function toUsageEvent(
  parsed: ParsedTranscriptEvent,
  attr: AttributionResult,
  provider: Provider,
): AgentUsageEvent {
  return {
    event_id: parsed.idempotency_key,
    provider,
    agent_id: attr.agent_id,
    dispatch_id: attr.dispatch_id,
    query_id: attr.query_id,
    session_id: parsed.session_id,
    model: parsed.model,
    ts: parsed.ts,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    cache_creation_input_tokens: parsed.cache_creation_input_tokens,
    cache_read_input_tokens: parsed.cache_read_input_tokens,
    raw_tokens: parsed.raw_tokens,
    weighted_tokens: parsed.weighted_tokens,
    source: "claude_code_transcripts",
    confidence: attr.confidence,
    idempotency_key: parsed.idempotency_key,
  };
}

/** Build the attribution maps from the live dispatch queue + agent registry. */
export async function buildAttributionContext(adapter: DbAdapter): Promise<AttributionContext> {
  const dispatchByQueryId = new Map<string, DispatchAttribution>();
  const dispatchByAgentQueryId = new Map<string, DispatchAttribution>();
  const agentWorkingDirs = new Map<string, string>();

  try {
    const { rows } = await adapter.query<{
      dispatch_phid: string;
      query_id: string | null;
      agent_query_id: string | null;
      to_agent: string | null;
    }>(`SELECT dispatch_phid, query_id, agent_query_id, to_agent FROM dispatch_scheduler_queue`, []);
    for (const r of rows) {
      const da: DispatchAttribution = {
        agent_id: r.to_agent ?? "_unknown",
        dispatch_id: r.dispatch_phid,
        query_id: r.query_id ?? undefined,
      };
      if (r.query_id) dispatchByQueryId.set(r.query_id, da);
      if (r.agent_query_id) dispatchByAgentQueryId.set(r.agent_query_id, da);
    }
  } catch {
    /* dispatch table absent (tests) — fall through to path-based attribution */
  }

  try {
    const { rows } = await adapter.query<{ name: string; working_directory: string | null }>(
      `SELECT name, working_directory FROM agents WHERE working_directory IS NOT NULL`,
      [],
    );
    for (const r of rows) {
      if (r.working_directory) agentWorkingDirs.set(r.name, r.working_directory);
    }
  } catch {
    /* agents table absent (tests) */
  }

  return { dispatchByQueryId, dispatchByAgentQueryId, sessionToAgent: new Map(), agentWorkingDirs };
}

/** Recursively collect `*.jsonl` files modified at/after `sinceMs`. Never throws. */
export function listTranscriptFiles(dir: string, sinceMs: number): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(...listTranscriptFiles(full, sinceMs));
      } else if (st.isFile() && name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) {
        out.push(full);
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return out;
}

/** Walk transcripts → parse → attribute → upsert idempotent usage events. */
export async function ingestTranscripts(
  adapter: DbAdapter,
  opts: IngestOptions = {},
): Promise<IngestTranscriptsResult> {
  const now = opts.now ?? (() => Date.now());
  const lookbackDays = opts.lookbackDays ?? 9;
  const dir = opts.transcriptsDir ?? join(homedir(), ".claude", "projects");
  const provider = opts.provider ?? "anthropic";
  const sinceMs = now() - lookbackDays * 86_400_000;

  const result: IngestTranscriptsResult = {
    files_scanned: 0,
    events_parsed: 0,
    inserted: 0,
    skipped_idempotent: 0,
    errors: 0,
    by_agent: {},
  };

  const ctx = await buildAttributionContext(adapter);
  const files = listTranscriptFiles(dir, sinceMs);

  for (const file of files) {
    result.files_scanned += 1;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      result.errors += 1;
      continue;
    }
    for (const parsed of parseTranscriptContent(content, file)) {
      result.events_parsed += 1;
      const attr = attributeEvent(parsed, ctx);
      const event = toUsageEvent(parsed, attr, provider);
      try {
        const { inserted } = await upsertAgentUsageEvent(adapter, event);
        if (inserted) {
          result.inserted += 1;
          result.by_agent[event.agent_id] = (result.by_agent[event.agent_id] ?? 0) + event.weighted_tokens;
        } else {
          result.skipped_idempotent += 1;
        }
      } catch {
        result.errors += 1;
      }
    }
  }

  return result;
}
