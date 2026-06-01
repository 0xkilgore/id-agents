// Usage Meter — agent attribution.
//
// Maps a parsed transcript event to an agent_id using progressively
// weaker signals:
//   canonical: query_id / agent_query_id maps to a dispatch row
//   derived: session_id maps to a known agent session
//   partial: transcript file path lives under an agent's working dir
//   _unknown: final fallback (still counted against global budget)
//
// Pure function. Caller builds the maps from the dispatch reactor +
// agent registry once per ingest run.

import type { ParsedTranscriptEvent } from "./transcripts.js";
import type { AttributionConfidence } from "./types.js";

export interface DispatchAttribution {
  agent_id: string;
  dispatch_id: string;
  query_id?: string;
}

export interface AttributionContext {
  /** query_id → dispatch (canonical mapping). */
  dispatchByQueryId: Map<string, DispatchAttribution>;
  /** agent_query_id → dispatch (canonical mapping). */
  dispatchByAgentQueryId: Map<string, DispatchAttribution>;
  /** session_id → agent_id (derived from session continuity). */
  sessionToAgent: Map<string, string>;
  /** agent_id → working directory absolute path (for partial matches). */
  agentWorkingDirs: Map<string, string>;
}

export interface AttributionResult {
  agent_id: string;
  dispatch_id: string | null;
  query_id: string | null;
  confidence: AttributionConfidence;
}

export function attributeEvent(
  event: ParsedTranscriptEvent,
  ctx: AttributionContext,
): AttributionResult {
  // 1. Canonical via query_id / agent_query_id (session_id often is one).
  const sid = event.session_id ?? "";
  if (sid) {
    const byQ = ctx.dispatchByQueryId.get(sid);
    if (byQ) {
      return {
        agent_id: byQ.agent_id,
        dispatch_id: byQ.dispatch_id,
        query_id: byQ.query_id ?? sid,
        confidence: "canonical",
      };
    }
    const byAq = ctx.dispatchByAgentQueryId.get(sid);
    if (byAq) {
      return {
        agent_id: byAq.agent_id,
        dispatch_id: byAq.dispatch_id,
        query_id: byAq.query_id ?? null,
        confidence: "canonical",
      };
    }
  }

  // 2. Derived via session-to-agent lookup.
  if (sid && ctx.sessionToAgent.has(sid)) {
    return {
      agent_id: ctx.sessionToAgent.get(sid)!,
      dispatch_id: null,
      query_id: null,
      confidence: "derived",
    };
  }

  // 3. Partial via transcript path matching an agent's working dir.
  const partial = pathToAgent(event.source_path, ctx.agentWorkingDirs);
  if (partial) {
    return {
      agent_id: partial,
      dispatch_id: null,
      query_id: null,
      confidence: "partial",
    };
  }

  // 4. _unknown final fallback.
  return {
    agent_id: "_unknown",
    dispatch_id: null,
    query_id: null,
    confidence: "partial",
  };
}

function pathToAgent(
  path: string,
  agentWorkingDirs: Map<string, string>,
): string | null {
  for (const [agentId, workingDir] of agentWorkingDirs) {
    if (path.includes(workingDir)) return agentId;
    // Claude Code projects encode the working dir as a single dir name
    // with slashes replaced by dashes; check that shape too.
    const encoded = workingDir.replace(/\//g, "-");
    if (encoded && path.includes(encoded)) return agentId;
  }
  return null;
}
