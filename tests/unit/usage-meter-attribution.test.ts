// Usage Meter — attribution tests.
// Map raw transcript events → agent_id using:
//   canonical: query_id or dispatch_id found in transcript metadata
//   derived: session_id mapped to an agent's known sessions
//   partial: transcript path contains agent working directory
//   _unknown: final fallback (still counts against global budget)

import { describe, it, expect } from "vitest";
import {
  attributeEvent,
  type AttributionContext,
} from "../../src/usage-meter/attribution.js";
import type { ParsedTranscriptEvent } from "../../src/usage-meter/transcripts.js";

function event(overrides: Partial<ParsedTranscriptEvent> = {}): ParsedTranscriptEvent {
  return {
    idempotency_key: "k1",
    model: "claude-sonnet-4-6",
    session_id: null,
    message_uuid: null,
    ts: Date.parse("2026-05-31T18:00:00.000Z"),
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    raw_tokens: 150,
    weighted_tokens: 150,
    source_path: "/Users/x/.claude/projects/some-project/abc.jsonl",
    source_line: 0,
    ...overrides,
  };
}

const baseCtx = (overrides: Partial<AttributionContext> = {}): AttributionContext => ({
  dispatchByQueryId: new Map(),
  dispatchByAgentQueryId: new Map(),
  sessionToAgent: new Map(),
  agentWorkingDirs: new Map(),
  ...overrides,
});

describe("attributeEvent — canonical: dispatch lookup by query_id in prompt", () => {
  it("session_id matches a known dispatch query_id → canonical confidence + agent_id", () => {
    const ctx = baseCtx({
      dispatchByQueryId: new Map([["query_xyz", { agent_id: "roger", dispatch_id: "phid:disp-1" }]]),
    });
    const ev = event({ session_id: "query_xyz" });
    const r = attributeEvent(ev, ctx);
    expect(r.agent_id).toBe("roger");
    expect(r.dispatch_id).toBe("phid:disp-1");
    expect(r.query_id).toBe("query_xyz");
    expect(r.confidence).toBe("canonical");
  });

  it("agent_query_id mapping (canonical)", () => {
    const ctx = baseCtx({
      dispatchByAgentQueryId: new Map([["agent_query_42", { agent_id: "cto", dispatch_id: "phid:disp-2", query_id: "query_orig" }]]),
    });
    const r = attributeEvent(event({ session_id: "agent_query_42" }), ctx);
    expect(r.agent_id).toBe("cto");
    expect(r.confidence).toBe("canonical");
  });
});

describe("attributeEvent — derived: session ID lookup", () => {
  it("session_id maps to an agent via the agent's known sessions", () => {
    const ctx = baseCtx({
      sessionToAgent: new Map([["session_abc", "roger"]]),
    });
    const r = attributeEvent(event({ session_id: "session_abc" }), ctx);
    expect(r.agent_id).toBe("roger");
    expect(r.confidence).toBe("derived");
  });
});

describe("attributeEvent — partial: transcript path matches agent working dir", () => {
  it("path prefix in agentWorkingDirs → partial confidence", () => {
    const ctx = baseCtx({
      agentWorkingDirs: new Map([["roger", "/Users/x/.claude/projects/some-project"]]),
    });
    const r = attributeEvent(
      event({ session_id: null, source_path: "/Users/x/.claude/projects/some-project/abc.jsonl" }),
      ctx,
    );
    expect(r.agent_id).toBe("roger");
    expect(r.confidence).toBe("partial");
  });

  it("path agent-name encoded as `-Users-foo-Code-roger`", () => {
    // Claude Code transcripts encode the working dir into the project
    // directory name with slashes replaced by dashes. Make sure we
    // recognize the agent name when it appears as the last segment.
    const ctx = baseCtx({
      agentWorkingDirs: new Map([["roger", "/Users/foo/Code/roger"]]),
    });
    const r = attributeEvent(
      event({ source_path: "/Users/foo/.claude/projects/-Users-foo-Code-roger/abc.jsonl" }),
      ctx,
    );
    expect(r.agent_id).toBe("roger");
    expect(r.confidence).toBe("partial");
  });
});

describe("attributeEvent — _unknown fallback", () => {
  it("no matches → _unknown + partial confidence", () => {
    const r = attributeEvent(event({ session_id: null }), baseCtx());
    expect(r.agent_id).toBe("_unknown");
    expect(r.confidence).toBe("partial");
  });
});

describe("attributeEvent — canonical wins over derived wins over partial", () => {
  it("canonical query_id match takes priority over partial path match", () => {
    const ctx = baseCtx({
      dispatchByQueryId: new Map([["query_xyz", { agent_id: "cto", dispatch_id: "phid:cto" }]]),
      agentWorkingDirs: new Map([["roger", "/Users/x/.claude/projects/some-project"]]),
    });
    const r = attributeEvent(
      event({ session_id: "query_xyz", source_path: "/Users/x/.claude/projects/some-project/abc.jsonl" }),
      ctx,
    );
    expect(r.agent_id).toBe("cto");
    expect(r.confidence).toBe("canonical");
  });

  it("derived session match takes priority over partial path", () => {
    const ctx = baseCtx({
      sessionToAgent: new Map([["session_abc", "cto"]]),
      agentWorkingDirs: new Map([["roger", "/Users/x/.claude/projects/some-project"]]),
    });
    const r = attributeEvent(
      event({ session_id: "session_abc", source_path: "/Users/x/.claude/projects/some-project/abc.jsonl" }),
      ctx,
    );
    expect(r.agent_id).toBe("cto");
    expect(r.confidence).toBe("derived");
  });
});
