// By-agent commit attribution — pure helpers + generated hook.
//
// Commits are all git-authored `0xkilgore`, so commit-stats.py cannot slice
// them by agent. The durable fix appends an `Agent: <name>` git trailer at
// commit time (worktree hook) and at promotion time (squash/merge body). These
// tests cover the pure trailer logic + the generated prepare-commit-msg hook.

import { describe, it, expect } from "vitest";
import {
  AGENT_TRAILER_KEY,
  ATTRIBUTION_MARKER_FILE,
  HOOK_SENTINEL,
  sanitizeAgentName,
  agentTrailerLine,
  hasAgentTrailer,
  appendAgentTrailer,
  buildPrepareCommitMsgHook,
} from "../../src/lib/agent-attribution.js";

describe("sanitizeAgentName", () => {
  it("trims and collapses newlines so the trailer stays one line", () => {
    expect(sanitizeAgentName("  roger  ")).toBe("roger");
    expect(sanitizeAgentName("rog\ner")).toBe("rog er");
    expect(sanitizeAgentName("a\r\nb")).toBe("a b");
  });
  it("returns empty for nullish/blank", () => {
    expect(sanitizeAgentName(null)).toBe("");
    expect(sanitizeAgentName(undefined)).toBe("");
    expect(sanitizeAgentName("   ")).toBe("");
  });
});

describe("agentTrailerLine", () => {
  it("builds `Agent: <name>` for a real agent", () => {
    expect(agentTrailerLine("hopper")).toBe("Agent: hopper");
    expect(AGENT_TRAILER_KEY).toBe("Agent");
  });
  it("returns null when there is no usable agent", () => {
    expect(agentTrailerLine("")).toBeNull();
    expect(agentTrailerLine(null)).toBeNull();
  });
});

describe("hasAgentTrailer", () => {
  it("detects an existing Agent trailer (case-insensitive, anywhere)", () => {
    expect(hasAgentTrailer("fix thing\n\nAgent: roger")).toBe(true);
    expect(hasAgentTrailer("x\n\nagent: roger")).toBe(true);
    expect(hasAgentTrailer("no trailer here")).toBe(false);
    expect(hasAgentTrailer("Agentless: nope")).toBe(false);
  });
});

describe("appendAgentTrailer", () => {
  it("appends in the same block when the body already ends with trailers", () => {
    const msg = "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
    expect(appendAgentTrailer(msg, "roger")).toBe(
      "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nAgent: roger",
    );
  });
  it("separates with a blank line when the body is prose", () => {
    expect(appendAgentTrailer("just a subject", "roger")).toBe("just a subject\n\nAgent: roger");
  });
  it("is idempotent — never double-appends", () => {
    const once = appendAgentTrailer("x", "roger");
    expect(appendAgentTrailer(once, "roger")).toBe(once);
  });
  it("returns the message unchanged when agent is empty", () => {
    expect(appendAgentTrailer("x", "")).toBe("x");
    expect(appendAgentTrailer("x", null)).toBe("x");
  });
});

describe("buildPrepareCommitMsgHook", () => {
  const hook = buildPrepareCommitMsgHook();
  it("carries the managed sentinel so installers can recognize their own hook", () => {
    expect(hook).toContain(HOOK_SENTINEL);
  });
  it("reads the per-worktree marker file and is a no-op without it", () => {
    expect(hook).toContain(ATTRIBUTION_MARKER_FILE);
    expect(hook).toMatch(/exit 0/);
  });
  it("guards against double attribution", () => {
    expect(hook).toMatch(/Agent:/);
    expect(hook).toMatch(/grep/);
  });
});
