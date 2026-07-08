import { describe, expect, it } from "vitest";
import { deriveTaskSurfaceState } from "../../src/tui/tasks/task-surface-state.js";

const NOW = 1_782_000_000_000;

function state(overrides: Partial<Parameters<typeof deriveTaskSurfaceState>[0]> = {}) {
  return deriveTaskSurfaceState({
    totalCount: 0,
    visibleCount: 0,
    selectedTeam: null,
    loading: false,
    errorMessage: null,
    lastUpdatedMs: NOW,
    nowMs: NOW,
    ...overrides,
  });
}

describe("TUI task surface state", () => {
  it("distinguishes index building from an empty task read model", () => {
    expect(state({ loading: true, lastUpdatedMs: 0 })).toMatchObject({
      state: "idle",
      label: "index building",
      emptyState: "index-building",
      emptyLabel: "building task index...",
    });

    expect(state({ loading: false, lastUpdatedMs: NOW, totalCount: 0, visibleCount: 0 })).toMatchObject({
      state: "idle",
      label: "current",
      emptyState: "no-tasks",
      emptyLabel: "no tasks recorded yet",
    });
  });

  it("distinguishes a team filter hiding task rows", () => {
    expect(state({ totalCount: 3, visibleCount: 0, selectedTeam: "kapelle" })).toMatchObject({
      emptyState: "filter-hidden",
      emptyLabel: "no tasks match team kapelle",
    });
  });

  it("surfaces manual refresh pending, acknowledged, failed, and refreshed results", () => {
    expect(state({ actionState: "pending" })).toMatchObject({
      state: "pending",
      label: "refresh pending",
      tone: "warning",
    });

    expect(state({ actionState: "acknowledged" })).toMatchObject({
      state: "acknowledged",
      label: "acknowledged",
      tone: "success",
    });

    expect(state({ actionState: "refreshed" })).toMatchObject({
      state: "refreshed",
      label: "refreshed",
      tone: "success",
    });

    expect(state({ actionState: "failed", actionMessage: "network down" })).toMatchObject({
      state: "failed",
      label: "refresh failed",
      tone: "danger",
      detail: "network down",
    });
  });

  it("marks existing rows stale when polling fails or age exceeds the threshold", () => {
    expect(state({ totalCount: 1, visibleCount: 1, errorMessage: "read model unavailable" })).toMatchObject({
      state: "stale",
      label: "stale",
      tone: "warning",
      detail: "read model unavailable",
    });

    expect(state({ totalCount: 1, visibleCount: 1, nowMs: NOW + 16_000 })).toMatchObject({
      state: "stale",
      label: "stale",
      tone: "warning",
      detail: "last refreshed 16s ago",
    });
  });
});
