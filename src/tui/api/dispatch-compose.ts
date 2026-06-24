// AP8 (AGENT-V2) — the pure core behind the agent-detail "dispatch to this
// agent" composer. The TUI collects a free-text message for the focused agent
// and POSTs it to the manager's POST /dispatch/enqueue.
//
// Everything decision-shaped lives here and is pure/unit-tested: validating the
// draft, attaching the operator actor_ref, and shaping the exact request body
// the manager route accepts. The TUI side is then a thin text buffer + fetch.
//
// Actor validity is the MANAGER's authority (it runs normalizeActorRef and 4xxs
// an unknown actor). The composer only defaults a known-good operator actor; it
// deliberately doesn't duplicate the core actor table (no drift), so this module
// stays dependency-free and inside the TUI's tsconfig rootDir.

/** Default operator behind the ops dashboard composer (Monday actor). */
export const DEFAULT_DISPATCH_ACTOR = "user:chris";

/** Hard cap on a composed message so a runaway paste can't be enqueued. */
export const MAX_DISPATCH_MESSAGE_LEN = 8000;

/** Draft collected by the composer before it is shaped into a request. */
export interface ComposeDraft {
  /** The focused agent the dispatch targets (agent name). */
  toAgent: string;
  /** Free-text body the operator typed. */
  message: string;
  /** Operator actor; defaults to {@link DEFAULT_DISPATCH_ACTOR}. */
  actorRef?: string;
  /** Optional one-line subject. */
  subject?: string;
  /** Optional numeric priority (lower = sooner). */
  priority?: number;
}

/** The exact JSON body POST /dispatch/enqueue accepts. */
export interface EnqueueDispatchBody {
  to_agent: string;
  message: string;
  actor_ref: string;
  subject?: string;
  priority?: number;
}

export type ComposeResult =
  | { ok: true; body: EnqueueDispatchBody }
  | { ok: false; error: string };

/**
 * Validate a composer draft and shape it into the enqueue request body. Pure,
 * deterministic, no I/O:
 *   - to_agent must be a non-empty (trimmed) name,
 *   - message must be non-empty (trimmed) and within the length cap,
 *   - actor_ref defaults to user:chris (a blank/whitespace ref also defaults);
 *     the manager remains the authority that an actor is accepted,
 *   - subject is included only when non-empty,
 *   - priority is included only when a finite number.
 */
export function buildAgentDispatchRequest(draft: ComposeDraft): ComposeResult {
  const toAgent = (draft.toAgent ?? "").trim();
  if (!toAgent) {
    return { ok: false, error: "no agent selected to dispatch to" };
  }

  const message = (draft.message ?? "").trim();
  if (!message) {
    return { ok: false, error: "dispatch message is empty" };
  }
  if (message.length > MAX_DISPATCH_MESSAGE_LEN) {
    return {
      ok: false,
      error: `dispatch message too long (${message.length} > ${MAX_DISPATCH_MESSAGE_LEN})`,
    };
  }

  const actorRef = (draft.actorRef ?? "").trim() || DEFAULT_DISPATCH_ACTOR;

  const body: EnqueueDispatchBody = {
    to_agent: toAgent,
    message,
    actor_ref: actorRef,
  };

  const subject = (draft.subject ?? "").trim();
  if (subject) body.subject = subject;

  if (draft.priority !== undefined) {
    if (typeof draft.priority !== "number" || !Number.isFinite(draft.priority)) {
      return { ok: false, error: "priority must be a finite number" };
    }
    body.priority = draft.priority;
  }

  return { ok: true, body };
}

/** Key event narrowed to the fields the composer's text editing cares about. */
export interface ComposerKey {
  backspace?: boolean;
  delete?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

/**
 * Apply one keypress to the composer's text buffer and return the next text.
 * Pure: printable input is appended; backspace/delete trims the last character;
 * control/navigation keys (and the submit/cancel keys, handled by the caller)
 * leave the text unchanged. Keeps the TUI's `useInput` handler a one-liner and
 * makes the editing behavior unit-testable without a render.
 */
export function applyComposerKeypress(text: string, input: string, key: ComposerKey): string {
  if (key.backspace || key.delete) {
    return text.slice(0, -1);
  }
  // Ignore control chords and navigation/submit keys — they don't edit text.
  if (
    key.ctrl ||
    key.return ||
    key.escape ||
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow
  ) {
    return text;
  }
  // Drop non-printable control characters (e.g. stray escape sequences) but keep
  // ordinary typed text (including spaces).
  if (!input || /[\x00-\x1f\x7f]/.test(input)) {
    return text;
  }
  return text + input;
}
