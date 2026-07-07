import type {
  LocalSearchEntityType,
  LocalSearchFreshness,
  LocalSearchIndexHealth,
} from "./contract.js";

export type LocalHealthVisualState =
  | "current"
  | "syncing"
  | "stale"
  | "event_gap"
  | "index_building"
  | "index_partial"
  | "mutation_failed"
  | "error";

export type LocalHealthVisualTone = "neutral" | "info" | "warning" | "danger";

export interface LocalHealthVisual {
  state: LocalHealthVisualState;
  label: string;
  tone: LocalHealthVisualTone;
  scope: string;
  message: string;
}

const VISUALS: Record<LocalHealthVisualState, Omit<LocalHealthVisual, "scope">> = {
  current: {
    state: "current",
    label: "Current",
    tone: "neutral",
    message: "Local cache is complete for this scope.",
  },
  syncing: {
    state: "syncing",
    label: "Syncing",
    tone: "info",
    message: "Local cache is catching up; newest changes may still be arriving.",
  },
  stale: {
    state: "stale",
    label: "Stale",
    tone: "warning",
    message: "Local cache is older than the live source for this scope.",
  },
  event_gap: {
    state: "event_gap",
    label: "Event gap",
    tone: "warning",
    message: "Some events are missing, so history may be incomplete.",
  },
  index_building: {
    state: "index_building",
    label: "Indexing",
    tone: "info",
    message: "Search index is being rebuilt; results may be sparse.",
  },
  index_partial: {
    state: "index_partial",
    label: "Partial index",
    tone: "warning",
    message: "Only part of the local index is available.",
  },
  mutation_failed: {
    state: "mutation_failed",
    label: "Update failed",
    tone: "danger",
    message: "A local read-state update did not persist.",
  },
  error: {
    state: "error",
    label: "Error",
    tone: "danger",
    message: "Local health could not be confirmed for this scope.",
  },
};

const FRESHNESS_VISUAL: Record<LocalSearchFreshness, LocalHealthVisualState> = {
  current: "current",
  syncing: "syncing",
  stale: "stale",
  event_gap: "event_gap",
  mutation_failed: "mutation_failed",
  error: "error",
};

export function localHealthVisualState(state: LocalHealthVisualState, scope = "item"): LocalHealthVisual {
  return { ...VISUALS[state], scope };
}

export function localHealthVisualForFreshness(
  freshness: LocalSearchFreshness | null | undefined,
  scope = "item",
): LocalHealthVisual {
  return localHealthVisualState(FRESHNESS_VISUAL[freshness ?? "current"], scope);
}

export function localHealthVisualForIndex(health: LocalSearchIndexHealth): LocalHealthVisual {
  switch (health.state) {
    case "ready":
      return localHealthVisualState("current", "search index");
    case "indexing":
      return localHealthVisualState("index_building", "search index");
    case "stale":
      return localHealthVisualState("stale", "search index");
    case "index_partial":
      return localHealthVisualState(
        "index_partial",
        health.partialScopes?.length ? scopeList(health.partialScopes) : "search index",
      );
    case "error":
      return localHealthVisualState("error", "search index");
  }
}

function scopeList(scopes: LocalSearchEntityType[]): string {
  return `${scopes.join(", ")} index`;
}
