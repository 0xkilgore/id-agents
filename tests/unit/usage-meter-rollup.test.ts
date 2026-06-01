// Usage Meter — rollup window math tests.
//
// Daily window: 00:00 → 24:00 in the configured timezone.
// Weekly window: Monday 00:00 → next Monday 00:00 in the configured timezone.
//
// We use America/Chicago for all tests since that's the operator default.

import { describe, it, expect } from "vitest";
import {
  computeDayWindow,
  computeWeekWindow,
  rollupEvents,
} from "../../src/usage-meter/rollup.js";

describe("computeDayWindow — America/Chicago", () => {
  it("returns [00:00, 24:00) for a daytime instant", () => {
    // 2026-05-31 14:30 UTC = 2026-05-31 09:30 CDT (CDT = UTC-5)
    const w = computeDayWindow(Date.parse("2026-05-31T14:30:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-05-31T00:00:00/);
    expect(w.end).toMatch(/^2026-06-01T00:00:00/);
  });

  it("handles a moment just before midnight (still same day)", () => {
    // 2026-06-01 04:00 UTC = 2026-05-31 23:00 CDT
    const w = computeDayWindow(Date.parse("2026-06-01T04:00:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-05-31T00:00:00/);
    expect(w.end).toMatch(/^2026-06-01T00:00:00/);
  });

  it("handles a moment just after midnight (new day)", () => {
    // 2026-06-01 06:00 UTC = 2026-06-01 01:00 CDT
    const w = computeDayWindow(Date.parse("2026-06-01T06:00:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-06-01T00:00:00/);
    expect(w.end).toMatch(/^2026-06-02T00:00:00/);
  });
});

describe("computeWeekWindow — America/Chicago, Monday-start", () => {
  it("Friday 2026-05-29 falls into the week starting Monday 2026-05-25", () => {
    const w = computeWeekWindow(Date.parse("2026-05-29T18:00:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-05-25T00:00:00/);
    expect(w.end).toMatch(/^2026-06-01T00:00:00/);
  });

  it("Monday 2026-06-01 00:30 CDT belongs to its OWN new week (not previous)", () => {
    const w = computeWeekWindow(Date.parse("2026-06-01T05:30:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-06-01T00:00:00/);
    expect(w.end).toMatch(/^2026-06-08T00:00:00/);
  });

  it("Sunday late-night belongs to the week that started that Monday", () => {
    // 2026-05-31 (Sunday) 23:00 CDT = 2026-06-01 04:00 UTC
    const w = computeWeekWindow(Date.parse("2026-06-01T04:00:00.000Z"), "America/Chicago");
    expect(w.start).toMatch(/^2026-05-25T00:00:00/);
    expect(w.end).toMatch(/^2026-06-01T00:00:00/);
  });
});

describe("rollupEvents — aggregates by window/agent", () => {
  function ev(agent: string, tsIso: string, weighted: number) {
    return {
      agent_id: agent,
      ts: Date.parse(tsIso),
      raw_tokens: weighted,
      weighted_tokens: weighted,
      model: "claude-sonnet-4-6",
      source: "claude_code_transcripts" as const,
      confidence: "canonical" as const,
    };
  }

  it("groups events by agent_id + day window", () => {
    const events = [
      ev("roger", "2026-05-31T14:00:00.000Z", 100),
      ev("roger", "2026-05-31T22:00:00.000Z", 50),
      ev("cto", "2026-05-31T15:00:00.000Z", 200),
    ];
    const rollups = rollupEvents(events, {
      provider: "anthropic",
      timezone: "America/Chicago",
      now_iso: "2026-05-31T22:00:00.000Z",
      window_kinds: ["day"],
    });
    const rogerDay = rollups.find((r) => r.agent_id === "roger" && r.window_kind === "day");
    expect(rogerDay?.weighted_tokens).toBe(150);
    expect(rogerDay?.requests).toBe(2);
    const ctoDay = rollups.find((r) => r.agent_id === "cto" && r.window_kind === "day");
    expect(ctoDay?.weighted_tokens).toBe(200);
  });

  it("emits a synthetic '_global' rollup that sums all agents", () => {
    const events = [
      ev("roger", "2026-05-31T14:00:00.000Z", 100),
      ev("cto", "2026-05-31T15:00:00.000Z", 200),
      ev("_unknown", "2026-05-31T16:00:00.000Z", 50),
    ];
    const rollups = rollupEvents(events, {
      provider: "anthropic",
      timezone: "America/Chicago",
      now_iso: "2026-05-31T22:00:00.000Z",
      window_kinds: ["day"],
    });
    const global = rollups.find((r) => r.agent_id === "_global" && r.window_kind === "day");
    expect(global?.weighted_tokens).toBe(350);
    expect(global?.requests).toBe(3);
  });

  it("emits both day and week rollups when both kinds requested", () => {
    const events = [ev("roger", "2026-05-29T14:00:00.000Z", 100)];
    const rollups = rollupEvents(events, {
      provider: "anthropic",
      timezone: "America/Chicago",
      now_iso: "2026-05-31T22:00:00.000Z",
      window_kinds: ["day", "week"],
    });
    // Event on Friday should NOT appear in the (now=Sunday) day rollup
    // (different day) but WILL appear in the week rollup.
    const rogerDay = rollups.find((r) => r.agent_id === "roger" && r.window_kind === "day");
    const rogerWeek = rollups.find((r) => r.agent_id === "roger" && r.window_kind === "week");
    expect(rogerDay).toBeUndefined();
    expect(rogerWeek?.weighted_tokens).toBe(100);
  });

  it("source_coverage counts events by source", () => {
    const events = [
      { ...ev("roger", "2026-05-31T14:00:00.000Z", 100), source: "claude_code_transcripts" as const },
      { ...ev("roger", "2026-05-31T14:01:00.000Z", 100), source: "manual_ingest" as const },
    ];
    const rollups = rollupEvents(events, {
      provider: "anthropic",
      timezone: "America/Chicago",
      now_iso: "2026-05-31T22:00:00.000Z",
      window_kinds: ["day"],
    });
    const rogerDay = rollups.find((r) => r.agent_id === "roger" && r.window_kind === "day");
    expect(rogerDay?.source_coverage).toEqual({
      claude_code_transcripts: 1,
      manual_ingest: 1,
    });
  });

  it("captures unique models seen", () => {
    const events = [
      { ...ev("roger", "2026-05-31T14:00:00.000Z", 100), model: "claude-sonnet-4-6" },
      { ...ev("roger", "2026-05-31T15:00:00.000Z", 100), model: "claude-opus-4-7" },
      { ...ev("roger", "2026-05-31T16:00:00.000Z", 100), model: "claude-sonnet-4-6" },
    ];
    const rollups = rollupEvents(events, {
      provider: "anthropic",
      timezone: "America/Chicago",
      now_iso: "2026-05-31T22:00:00.000Z",
      window_kinds: ["day"],
    });
    const rogerDay = rollups.find((r) => r.agent_id === "roger" && r.window_kind === "day");
    expect(rogerDay?.models.sort()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});
