// Unit tests for bounded RRULE expansion.
//
// V0 supports the RFC 5545 subset our migration jobs need:
//   - FREQ=DAILY|WEEKLY|MONTHLY|YEARLY
//   - INTERVAL=N (drives biweekly via FREQ=WEEKLY;INTERVAL=2)
//   - BYDAY=MO,TU,WE,TH,FR,SA,SU (for FREQ=WEEKLY)
//   - UNTIL=YYYYMMDD or YYYYMMDDTHHMMSSZ
//   - COUNT=N (bounded; cap respected)
//
// Per CTO scope: expansion is bounded server-side within
// [now, now + horizon_days]; exception_dates are dropped from the
// emitted list; the result is sorted ascending.

import { describe, expect, it } from "vitest";

import {
  defaultHorizonForRrule,
  expandRrule,
  parseRrule,
} from "../../src/recurrences/rrule.js";

describe("parseRrule", () => {
  it("parses FREQ + INTERVAL + BYDAY + UNTIL", () => {
    const parsed = parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20271231");
    expect(parsed.freq).toBe("WEEKLY");
    expect(parsed.interval).toBe(2);
    expect(parsed.byday).toEqual(["MO", "WE"]);
    expect(parsed.until).toBe("20271231");
  });

  it("defaults INTERVAL to 1 when absent", () => {
    const parsed = parseRrule("FREQ=DAILY");
    expect(parsed.interval).toBe(1);
  });

  it("accepts an RRULE: prefix per RFC 5545", () => {
    const parsed = parseRrule("RRULE:FREQ=WEEKLY;BYDAY=SU");
    expect(parsed.freq).toBe("WEEKLY");
    expect(parsed.byday).toEqual(["SU"]);
  });

  it("rejects an unsupported FREQ", () => {
    expect(() => parseRrule("FREQ=HOURLY")).toThrow(/unsupported FREQ/i);
  });

  it("rejects malformed input", () => {
    expect(() => parseRrule("garbage")).toThrow();
  });
});

describe("defaultHorizonForRrule", () => {
  it("daily -> 2 days", () => {
    expect(defaultHorizonForRrule("FREQ=DAILY")).toBe(2);
  });
  it("weekly -> 7 days", () => {
    expect(defaultHorizonForRrule("FREQ=WEEKLY")).toBe(7);
  });
  it("biweekly (FREQ=WEEKLY;INTERVAL=2) -> 14 days", () => {
    expect(defaultHorizonForRrule("FREQ=WEEKLY;INTERVAL=2")).toBe(14);
  });
  it("monthly -> 30 days", () => {
    expect(defaultHorizonForRrule("FREQ=MONTHLY")).toBe(30);
  });
  it("yearly -> 45 days", () => {
    expect(defaultHorizonForRrule("FREQ=YEARLY")).toBe(45);
  });
});

describe("expandRrule — daily", () => {
  it("emits one fire per day inside the window, sorted ascending", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY",
      starts_on: "2026-06-10",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-11T00:00:00Z",
      window_end: "2026-06-14T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-11T00:00:00Z",
      "2026-06-12T00:00:00Z",
      "2026-06-13T00:00:00Z",
    ]);
  });

  it("honors exception_dates", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY",
      starts_on: "2026-06-10",
      timezone: "UTC",
      exception_dates: ["2026-06-12"],
      window_start: "2026-06-11T00:00:00Z",
      window_end: "2026-06-14T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-11T00:00:00Z",
      "2026-06-13T00:00:00Z",
    ]);
  });

  it("honors UNTIL", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY;UNTIL=20260612",
      starts_on: "2026-06-10",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-11T00:00:00Z",
      window_end: "2026-06-20T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-11T00:00:00Z",
      "2026-06-12T00:00:00Z",
    ]);
  });
});

describe("expandRrule — weekly with BYDAY", () => {
  it("Sunday weekly product log: BYDAY=SU emits Sundays only", () => {
    // 2026-06-14 is a Sunday.
    const out = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      starts_on: "2026-06-14",
      timezone: "America/Chicago",
      exception_dates: [],
      window_start: "2026-06-12T05:00:00Z", // 2026-06-12 00:00 America/Chicago
      window_end: "2026-07-06T05:00:00Z",
    });
    // Expect 4 Sundays: 06-14, 06-21, 06-28, 07-05 (all at local
    // midnight, which is 05:00Z in CDT America/Chicago).
    expect(out).toEqual([
      "2026-06-14T05:00:00Z",
      "2026-06-21T05:00:00Z",
      "2026-06-28T05:00:00Z",
      "2026-07-05T05:00:00Z",
    ]);
  });

  it("multiple BYDAY values emit one per day per week", () => {
    const out = expandRrule({
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      starts_on: "2026-06-08",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-08T00:00:00Z",
      window_end: "2026-06-15T00:00:00Z",
    });
    // 2026-06-08 = Mon, 06-10 = Wed, 06-12 = Fri.
    expect(out).toEqual([
      "2026-06-08T00:00:00Z",
      "2026-06-10T00:00:00Z",
      "2026-06-12T00:00:00Z",
    ]);
  });

  it("biweekly via INTERVAL=2 skips every other week", () => {
    const out = expandRrule({
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU",
      starts_on: "2026-06-14",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-14T00:00:00Z",
      window_end: "2026-07-13T00:00:00Z",
    });
    // 06-14, 06-28, 07-12 (every other Sunday).
    expect(out).toEqual([
      "2026-06-14T00:00:00Z",
      "2026-06-28T00:00:00Z",
      "2026-07-12T00:00:00Z",
    ]);
  });
});

describe("expandRrule — monthly", () => {
  it("monthly on the same day-of-month", () => {
    const out = expandRrule({
      rrule: "FREQ=MONTHLY",
      starts_on: "2026-06-15",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-15T00:00:00Z",
      window_end: "2026-10-01T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-15T00:00:00Z",
      "2026-07-15T00:00:00Z",
      "2026-08-15T00:00:00Z",
      "2026-09-15T00:00:00Z",
    ]);
  });
});

describe("expandRrule — bounded by window", () => {
  it("never emits before window_start", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY",
      starts_on: "2026-06-01",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-10T00:00:00Z",
      window_end: "2026-06-12T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-10T00:00:00Z",
      "2026-06-11T00:00:00Z",
    ]);
  });

  it("emits no instances when the window is in the past relative to UNTIL", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY;UNTIL=20260601",
      starts_on: "2026-05-01",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-10T00:00:00Z",
      window_end: "2026-06-20T00:00:00Z",
    });
    expect(out).toEqual([]);
  });

  it("hard caps total emitted instances at MAX_EXPANSION_INSTANCES", async () => {
    const { MAX_EXPANSION_INSTANCES } = await import(
      "../../src/recurrences/rrule.js"
    );
    const out = expandRrule({
      rrule: "FREQ=DAILY",
      starts_on: "2026-01-01",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-01-01T00:00:00Z",
      // 10 years of daily fires would be ~3,650; cap should bite.
      window_end: "2036-01-01T00:00:00Z",
    });
    expect(out.length).toBe(MAX_EXPANSION_INSTANCES);
  });
});

describe("expandRrule — COUNT", () => {
  it("stops emitting after COUNT instances since starts_on", () => {
    const out = expandRrule({
      rrule: "FREQ=DAILY;COUNT=3",
      starts_on: "2026-06-10",
      timezone: "UTC",
      exception_dates: [],
      window_start: "2026-06-10T00:00:00Z",
      window_end: "2026-06-20T00:00:00Z",
    });
    expect(out).toEqual([
      "2026-06-10T00:00:00Z",
      "2026-06-11T00:00:00Z",
      "2026-06-12T00:00:00Z",
    ]);
  });
});
