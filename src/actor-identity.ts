// Monday second-user actor identity foundation (Liz build plan §1).
//
// Two fixed, hardcoded operator profiles — Chris and Liz. The server accepts
// ONLY these two actors on Monday-relevant mutating routes; clients cannot
// submit arbitrary actor ids. Existing Chris flows (which pass "chris" /
// "human:chris") keep resolving to user:chris.
//
// Also hosts RD-001: a stable-artifact-id guard so review operations target a
// real artifact_id, never a display id, basename, queue index, or path.

export type MondayActorRef = "user:chris" | "user:liz";

export interface Actor {
  type: "user";
  id: "chris" | "liz";
  ref: MondayActorRef;
  displayName: "Chris" | "Liz";
  source: "ops-profile";
}

export const MONDAY_ACTORS: Record<MondayActorRef, Actor> = {
  "user:chris": { type: "user", id: "chris", ref: "user:chris", displayName: "Chris", source: "ops-profile" },
  "user:liz": { type: "user", id: "liz", ref: "user:liz", displayName: "Liz", source: "ops-profile" },
};

export type ActorErrorCode = "missing_actor" | "unknown_actor";

export type NormalizeActorResult =
  | { ok: true; actor: Actor }
  | { ok: false; code: ActorErrorCode; error: string };

// Aliases that resolve to a fixed Monday actor. Keeps existing Chris flows
// ("chris" / "human:chris") working without widening the accepted actor set.
const ALIASES: Record<string, MondayActorRef> = {
  "user:chris": "user:chris",
  chris: "user:chris",
  "human:chris": "user:chris",
  "user:liz": "user:liz",
  liz: "user:liz",
  "human:liz": "user:liz",
};

/**
 * Normalize a client-supplied actor reference to a fixed Monday Actor. Missing
 * → typed missing_actor; anything outside the two fixed actors → unknown_actor.
 * Pure.
 */
export function normalizeActorRef(input: unknown): NormalizeActorResult {
  if (input == null || (typeof input === "string" && input.trim() === "")) {
    return { ok: false, code: "missing_actor", error: "actor is required (user:chris or user:liz)" };
  }
  if (typeof input !== "string") {
    return { ok: false, code: "unknown_actor", error: "actor must be a string ref (user:chris or user:liz)" };
  }
  const ref = ALIASES[input.trim().toLowerCase()];
  if (!ref) {
    return {
      ok: false,
      code: "unknown_actor",
      error: `unknown actor "${input}" — only user:chris and user:liz are accepted`,
    };
  }
  return { ok: true, actor: MONDAY_ACTORS[ref] };
}

/**
 * RD-001: is `id` a stable artifact_id (vs a display id / basename / queue
 * index / path)? Accepts the `art-<hash>`, `art:<doc:model>` and `phid:` forms;
 * rejects paths (contain "/"), bare numeric indexes, and anything without a
 * recognized stable-id prefix (e.g. a basename like "loops-review.md"). Pure.
 */
export function isValidArtifactId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const s = id.trim();
  if (s.length === 0) return false;
  if (s.includes("/")) return false; // a path, not an id
  if (/^\d+$/.test(s)) return false; // a queue position / index
  return /^(art[-:]|phid:)/.test(s); // art-<hash> | art:<doc:model> | phid:...
}
