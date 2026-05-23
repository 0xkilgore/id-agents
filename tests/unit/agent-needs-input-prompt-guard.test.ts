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

// Spec 054 v2 Part 2 Step 10: promotion closeout guard.
describe("PROTOCOL_DEFAULTS — promotion closeout guard", () => {
  it("includes the canonical Part 2 promotion section header", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/Promotion as the canonical final build step/);
  });

  it("names the promote-to-main CLI helper", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/id-agents promote-to-main/);
  });

  it("shows the required CLI flags so a scheduler-launched agent can run it without asking for shape", () => {
    for (const flag of ["--repo", "--branch", "--base", "--remote", "--strategy", "--dispatch-id", "--smoke", "--execute"]) {
      expect(PROTOCOL_DEFAULTS).toContain(flag);
    }
  });

  it("shows the /agent-done promotion payload shape (required, completed, repos)", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/"required":\s*true/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"completed":\s*true/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"repos":/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"promoted_sha"/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"remote_main_sha"/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"pushed":\s*true/);
    expect(PROTOCOL_DEFAULTS).toMatch(/"verified":\s*true/);
  });

  it("documents the four skip rules (explicit-false, WIP, long-lived, follow-up)", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/promote:\s*false/);
    expect(PROTOCOL_DEFAULTS).toMatch(/WIP/);
    expect(PROTOCOL_DEFAULTS).toMatch(/long-lived/);
    expect(PROTOCOL_DEFAULTS).toMatch(/follow-up dispatch/);
  });

  it("references the SPEC054_PROMOTION_ENFORCEMENT env var + warn|enforce semantics", () => {
    expect(PROTOCOL_DEFAULTS).toContain("SPEC054_PROMOTION_ENFORCEMENT");
    expect(PROTOCOL_DEFAULTS).toMatch(/warn/);
    expect(PROTOCOL_DEFAULTS).toMatch(/enforce/);
  });

  it("forbids force-push and tells the agent to ask via /agent-needs-input on ambiguous ancestry", () => {
    expect(PROTOCOL_DEFAULTS).toMatch(/force.*push/i);
    expect(PROTOCOL_DEFAULTS).toMatch(/divergent ancestry/i);
  });
});
