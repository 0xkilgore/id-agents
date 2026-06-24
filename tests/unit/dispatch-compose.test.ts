// AP8 (AGENT-V2) — the pure core behind the agent-detail "dispatch to this
// agent" composer: draft validation/shaping and the composer text-edit reducer.

import { describe, it, expect } from "vitest";
import {
  buildAgentDispatchRequest,
  applyComposerKeypress,
  DEFAULT_DISPATCH_ACTOR,
  MAX_DISPATCH_MESSAGE_LEN,
} from "../../src/tui/api/dispatch-compose.js";

const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

describe("buildAgentDispatchRequest", () => {
  it("shapes a valid draft into the enqueue body with the default actor", () => {
    const res = buildAgentDispatchRequest({ toAgent: "roger", message: "build AP8" });
    expect(res).toEqual({
      ok: true,
      body: { to_agent: "roger", message: "build AP8", actor_ref: DEFAULT_DISPATCH_ACTOR },
    });
  });

  it("trims to_agent and message", () => {
    const res = buildAgentDispatchRequest({ toAgent: "  roger  ", message: "  hi there \n" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body.to_agent).toBe("roger");
      expect(res.body.message).toBe("hi there");
    }
  });

  it("rejects a missing/blank agent", () => {
    expect(buildAgentDispatchRequest({ toAgent: "", message: "x" })).toEqual({
      ok: false,
      error: "no agent selected to dispatch to",
    });
    expect(buildAgentDispatchRequest({ toAgent: "   ", message: "x" }).ok).toBe(false);
  });

  it("rejects an empty/whitespace message", () => {
    expect(buildAgentDispatchRequest({ toAgent: "roger", message: "" })).toEqual({
      ok: false,
      error: "dispatch message is empty",
    });
    expect(buildAgentDispatchRequest({ toAgent: "roger", message: "   \n  " }).ok).toBe(false);
  });

  it("rejects a message over the length cap", () => {
    const long = "a".repeat(MAX_DISPATCH_MESSAGE_LEN + 1);
    const res = buildAgentDispatchRequest({ toAgent: "roger", message: long });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too long/);
  });

  it("accepts a message exactly at the length cap", () => {
    const exact = "a".repeat(MAX_DISPATCH_MESSAGE_LEN);
    expect(buildAgentDispatchRequest({ toAgent: "roger", message: exact }).ok).toBe(true);
  });

  it("defaults a blank actorRef to the dashboard operator", () => {
    const res = buildAgentDispatchRequest({ toAgent: "roger", message: "x", actorRef: "  " });
    expect(res.ok && res.body.actor_ref).toBe(DEFAULT_DISPATCH_ACTOR);
  });

  it("passes an explicit actorRef through (server is the authority on validity)", () => {
    const res = buildAgentDispatchRequest({ toAgent: "roger", message: "x", actorRef: "user:liz" });
    expect(res.ok && res.body.actor_ref).toBe("user:liz");
  });

  it("includes subject only when non-empty", () => {
    const withSubj = buildAgentDispatchRequest({ toAgent: "r", message: "m", subject: " ship it " });
    expect(withSubj.ok && withSubj.body.subject).toBe("ship it");
    const blankSubj = buildAgentDispatchRequest({ toAgent: "r", message: "m", subject: "   " });
    expect(blankSubj.ok && "subject" in blankSubj.body).toBe(false);
  });

  it("includes priority only when a finite number, else errors", () => {
    const withP = buildAgentDispatchRequest({ toAgent: "r", message: "m", priority: 3 });
    expect(withP.ok && withP.body.priority).toBe(3);
    const nan = buildAgentDispatchRequest({ toAgent: "r", message: "m", priority: NaN });
    expect(nan).toEqual({ ok: false, error: "priority must be a finite number" });
    const noP = buildAgentDispatchRequest({ toAgent: "r", message: "m" });
    expect(noP.ok && "priority" in noP.body).toBe(false);
  });
});

describe("applyComposerKeypress", () => {
  it("appends printable input", () => {
    expect(applyComposerKeypress("ab", "c", {})).toBe("abc");
    expect(applyComposerKeypress("", "h", {})).toBe("h");
  });

  it("appends a space", () => {
    expect(applyComposerKeypress("hi", " ", {})).toBe("hi ");
  });

  it("removes the last char on backspace/delete", () => {
    expect(applyComposerKeypress("abc", "", { backspace: true })).toBe("ab");
    expect(applyComposerKeypress("abc", "", { delete: true })).toBe("ab");
    expect(applyComposerKeypress("", "", { backspace: true })).toBe("");
  });

  it("ignores control chords and navigation/submit keys", () => {
    expect(applyComposerKeypress("abc", "v", { ctrl: true })).toBe("abc");
    expect(applyComposerKeypress("abc", "", { return: true })).toBe("abc");
    expect(applyComposerKeypress("abc", "", { escape: true })).toBe("abc");
    expect(applyComposerKeypress("abc", "", { tab: true })).toBe("abc");
    expect(applyComposerKeypress("abc", "", { upArrow: true })).toBe("abc");
    expect(applyComposerKeypress("abc", "", { leftArrow: true })).toBe("abc");
  });

  it("drops non-printable control characters and empty input", () => {
    expect(applyComposerKeypress("abc", "", {})).toBe("abc");
    expect(applyComposerKeypress("abc", ESC, {})).toBe("abc");
    expect(applyComposerKeypress("abc", DEL, {})).toBe("abc");
    expect(applyComposerKeypress("abc", NUL, {})).toBe("abc");
  });
});
