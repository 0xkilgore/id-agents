/**
 * STUB-S6 (dashboard page.tsx:270) — trailing-24h failed-dispatch filter.
 *
 * Pins the pure logic behind `GET /dispatches/failed-24h`: keep only rows
 * with the raw terminal status `'failed'` whose failure instant
 * (completed_at, falling back to updated_at) lands within the trailing window.
 * Auto-recovered rows are flipped to `'done'` upstream so they are correctly
 * excluded by the status check.
 */

import { test, expect } from "vitest";

import {
  failedDispatchesWithin,
  FAILED_24H_WINDOW_MS,
  type DispatchReadRow,
} from "../../src/dispatch-scheduler/read-model";

const NOW = "2026-06-23T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const agoIso = (ms: number) => new Date(nowMs - ms).toISOString();
const H = 60 * 60 * 1000;

// failedDispatchesWithin only reads status/completed_at/updated_at.
function row(overrides: Partial<DispatchReadRow>): DispatchReadRow {
  return {
    dispatch_phid: "phid:d",
    status: "failed",
    completed_at: agoIso(H),
    updated_at: agoIso(H),
    ...overrides,
  } as unknown as DispatchReadRow;
}

test("FAILED_24H_WINDOW_MS is 24 hours", () => {
  expect(FAILED_24H_WINDOW_MS).toBe(24 * H);
});

test("includes a failed dispatch that completed within 24h", () => {
  const rows = [row({ dispatch_phid: "phid:recent", completed_at: agoIso(2 * H) })];
  const out = failedDispatchesWithin(rows, NOW);
  expect(out.map((r) => r.dispatch_phid)).toEqual(["phid:recent"]);
});

test("excludes a failed dispatch older than 24h", () => {
  const rows = [row({ dispatch_phid: "phid:old", completed_at: agoIso(25 * H) })];
  expect(failedDispatchesWithin(rows, NOW)).toEqual([]);
});

test("excludes non-failed terminal rows even when recent", () => {
  const rows = [
    row({ dispatch_phid: "phid:done", status: "done", completed_at: agoIso(1 * H) }),
    row({ dispatch_phid: "phid:cancelled", status: "cancelled", completed_at: agoIso(1 * H) }),
    row({ dispatch_phid: "phid:failed", status: "failed", completed_at: agoIso(1 * H) }),
  ];
  expect(failedDispatchesWithin(rows, NOW).map((r) => r.dispatch_phid)).toEqual(["phid:failed"]);
});

test("falls back to updated_at when completed_at is null", () => {
  const rows = [
    row({ dispatch_phid: "phid:nocompleted", completed_at: null, updated_at: agoIso(3 * H) }),
  ];
  expect(failedDispatchesWithin(rows, NOW).map((r) => r.dispatch_phid)).toEqual(["phid:nocompleted"]);
});

test("boundary: a failure exactly at the cutoff is included", () => {
  const rows = [row({ dispatch_phid: "phid:edge", completed_at: agoIso(FAILED_24H_WINDOW_MS) })];
  expect(failedDispatchesWithin(rows, NOW).map((r) => r.dispatch_phid)).toEqual(["phid:edge"]);
});

test("honors a custom (smaller) window", () => {
  const rows = [
    row({ dispatch_phid: "phid:1h", completed_at: agoIso(1 * H) }),
    row({ dispatch_phid: "phid:2h", completed_at: agoIso(2 * H) }),
  ];
  const out = failedDispatchesWithin(rows, NOW, 1 * H + 1);
  expect(out.map((r) => r.dispatch_phid)).toEqual(["phid:1h"]);
});

test("returns [] when now is unparseable", () => {
  expect(failedDispatchesWithin([row({})], "not-a-date")).toEqual([]);
});

test("excludes rows with an unparseable timestamp", () => {
  const rows = [row({ dispatch_phid: "phid:bad", completed_at: "garbage", updated_at: "garbage" })];
  expect(failedDispatchesWithin(rows, NOW)).toEqual([]);
});
