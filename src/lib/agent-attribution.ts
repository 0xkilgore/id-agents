// By-agent commit attribution.
//
// Every commit in our repos is git-authored `0xkilgore`, so the commit-stats
// tracker (cane/scripts/commit-stats.py) cannot slice commits by agent. The
// durable fix appends an `Agent: <name>` git trailer (alongside the existing
// `Co-Authored-By`) at the two places a commit acquires its message:
//
//   1. The agent's own commits — a `prepare-commit-msg` hook installed in the
//      leased worktree at allocation time (see workspaces/allocator.ts). This
//      covers the common fast-forward promotion case, where the agent's
//      original commits are exactly what lands on `main`.
//   2. Promotion-created commits — the squash/merge body built by
//      `id-agents promote-to-main` (see cli/promote-to-main.ts).
//
// commit-stats.py then reads the `Agent:` trailer to attribute by agent.
//
// This module is the single source of truth for the trailer shape so all three
// surfaces agree.

export const AGENT_TRAILER_KEY = "Agent";

/** Filename of the per-worktree marker the hook reads (in the worktree git dir). */
export const ATTRIBUTION_MARKER_FILE = "agent-attribution";

/** Sentinel embedded in the generated hook so installers recognize their own. */
export const HOOK_SENTINEL = "id-agents-managed:agent-commit-attribution";

/** Strip anything that would corrupt a one-line git trailer value. */
export function sanitizeAgentName(agent: string | null | undefined): string {
  if (!agent) return "";
  return agent.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** `Agent: <name>` trailer line, or null when there is no usable agent. */
export function agentTrailerLine(agent: string | null | undefined): string | null {
  const a = sanitizeAgentName(agent);
  return a ? `${AGENT_TRAILER_KEY}: ${a}` : null;
}

/** True when `message` already carries an `Agent:` trailer. */
export function hasAgentTrailer(message: string): boolean {
  return /^Agent:[ \t]*\S/im.test(message);
}

/**
 * Append an `Agent: <name>` trailer to a commit message, idempotently.
 *
 * Returns the message unchanged when `agent` is empty or an `Agent:` trailer
 * already exists. When the message already ends with a trailer-shaped line
 * (e.g. `Co-Authored-By: …`) the new trailer joins that block; otherwise it is
 * separated from the prose body by a blank line.
 */
export function appendAgentTrailer(message: string, agent: string | null | undefined): string {
  const line = agentTrailerLine(agent);
  if (!line) return message;
  if (hasAgentTrailer(message)) return message;
  const trimmed = message.replace(/\s+$/, "");
  if (trimmed === "") return line;
  const lastLine = trimmed.split("\n").pop() ?? "";
  const inTrailerBlock = /^[A-Za-z][A-Za-z-]*:\s/.test(lastLine);
  return `${trimmed}${inTrailerBlock ? "\n" : "\n\n"}${line}`;
}

/**
 * The `prepare-commit-msg` hook script installed into a leased worktree's repo.
 *
 * It reads the agent name from a per-worktree marker file written at allocation
 * time and appends an `Agent: <name>` trailer to every commit message that does
 * not already carry one. It is a strict no-op outside leased worktrees (the
 * protected root has no marker) and never fails a commit (always exits 0).
 */
export function buildPrepareCommitMsgHook(): string {
  return `#!/bin/sh
# ${HOOK_SENTINEL}
# Appends an "Agent: <name>" trailer (from the leased-worktree marker) so
# commit-stats.py can slice commits by agent. No-op outside leased worktrees;
# never blocks a commit.
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
marker="$gitdir/${ATTRIBUTION_MARKER_FILE}"
[ -f "$marker" ] || exit 0
agent=$(head -n1 "$marker" | tr -d '\\r\\n' | sed 's/[[:space:]]*$//')
[ -n "$agent" ] || exit 0
msgfile="$1"
[ -n "$msgfile" ] && [ -f "$msgfile" ] || exit 0
# Idempotent: leave an already-attributed message untouched (amend/squash/rebase).
grep -qiE '^Agent:[[:space:]]' "$msgfile" && exit 0
printf '\\nAgent: %s\\n' "$agent" >> "$msgfile"
exit 0
`;
}
