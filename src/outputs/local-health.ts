import {
  localHealthVisualState,
  type LocalHealthVisual,
} from "../local-search/visual-state.js";
import type {
  ArtifactAvailability,
  ArtifactDetailBody,
  OutputsInboxRow,
} from "./types.js";

export function artifactListVisualState(input: {
  availability: ArtifactAvailability;
  status?: OutputsInboxRow["status"];
  catalogPresent: boolean;
}): LocalHealthVisual {
  if (input.status === "ship_blocked") {
    return localHealthVisualState("mutation_failed", "artifact action");
  }
  if (input.availability === "missing") {
    return localHealthVisualState("error", "artifact file");
  }
  if (!input.catalogPresent || input.availability === "unknown") {
    return localHealthVisualState("stale", "artifact catalog");
  }
  return localHealthVisualState("current", "artifact");
}

export function artifactDetailVisualState(input: {
  availability: ArtifactAvailability;
  body: ArtifactDetailBody;
  catalogPresent: boolean;
  status: OutputsInboxRow["status"];
}): LocalHealthVisual {
  if (input.status === "ship_blocked") {
    return localHealthVisualState("mutation_failed", "artifact action");
  }
  if (input.body.kind === "missing" || input.body.kind === "unavailable" || input.availability === "missing") {
    return localHealthVisualState("error", "artifact body");
  }
  if (!input.catalogPresent || input.availability === "unknown") {
    return localHealthVisualState("stale", "artifact catalog");
  }
  return localHealthVisualState("current", "artifact detail");
}
