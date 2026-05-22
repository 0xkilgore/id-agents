// Spec 054 v2 Step 4: PROTOCOL_DEFAULTS guard.
//
// PROTOCOL_DEFAULTS is injected into every agent's CLAUDE.md at spawn
// time. It MUST tell agents to call POST /agent-needs-input when they
// are blocked, instead of writing "standing by" in chat. Removing
// these instructions silently regresses the protocol primitive built
// in Steps 1-3 - this test fails the build if anyone strips them.

import { describe, it, expect } from "vitest";
import { PROTOCOL_DEFAULTS } from "../../src/protocol-defaults.js";

describe("PROTOCOL_DEFAULTS — /agent-needs-input guard", () => {
  it("includes the POST /agent-needs-input endpoint instruction", () => {
    expect(PROTOCOL_DEFAULTS).toContain("/agent-needs-input");
  });

  it("tells the agent to use dispatch_id, not only query_id", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/dispatch_id/);
  });

  it("provides a concrete curl example (so agents without a first-class tool can call it)", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/curl[\s\S]+\/agent-needs-input/);
  });

  it("requires agent to stop after the endpoint succeeds (no 'standing by' replies)", () => {
    expect(PROTOCOL_DEFAULTS.toLowerCase()).toMatch(/stop[\s\S]+wait/);
    expect(PROTOCOL_DEFAULTS).toMatch(/standing by.*NOT acceptable/i);
  });

  it("references /agent-resume as the response path", () => {
    expect(PROTOCOL_DEFAULTS).toContain("/agent-resume");
  });

  it("documents 'when to call' AND 'when NOT to call' so agents do not over-call", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/When to call/);
    expect(PROTOCOL_DEFAULTS).toMatch(/When NOT to call/);
  });
});
