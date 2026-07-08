import type { TaskRow } from "../db/types.js";
import { classifyTaskBand, extractTaskScheduleFacts, type TaskBandKind } from "../tasks-readmodel/bands.js";

export type TaskCurrentnessState = "current" | "stale" | "blocked" | "needs_chris" | "done" | "archived";
export type TaskReviewBucket =
  | "actionable_ready"
  | "needs_approval"
  | "stale"
  | "blocked_or_failed"
  | "done"
  | "duplicate_or_noop";

export interface TaskTitleAudit {
  full_title: string;
  display_title: string;
  compacted: boolean;
  max_chars: number;
  rule: "unchanged" | "word_boundary_ellipsis" | "hard_boundary_ellipsis";
}

export interface TaskCurrentness {
  state: TaskCurrentnessState;
  bucket: TaskReviewBucket;
  band: TaskBandKind;
  urgency: "now" | "today" | "soon" | "later" | "none";
  stale: boolean;
  stale_reason: string | null;
  needs_chris: boolean;
  proposed_action: "none" | "review_stale" | "assign_owner" | "resume_or_close" | "archive_or_done";
  evidence: string[];
}

export interface TaskReconciliationFacts {
  title: TaskTitleAudit;
  currentness: TaskCurrentness;
}

export interface TaskReconciliationSummary {
  actionable_ready: number;
  needs_approval: number;
  stale: number;
  duplicate_or_noop: number;
  blocked_or_failed: number;
  done: number;
}

const DEFAULT_TITLE_MAX = 90;
const DEFAULT_STALE_AFTER_DAYS = 7;

export function compactTaskTitle(title: string, maxChars = DEFAULT_TITLE_MAX): TaskTitleAudit {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return {
      full_title: title,
      display_title: normalized,
      compacted: false,
      max_chars: maxChars,
      rule: "unchanged",
    };
  }

  const suffix = "...";
  const room = Math.max(1, maxChars - suffix.length);
  const boundary = normalized.slice(0, room + 1).search(/\s+\S*$/);
  const prefix = boundary >= Math.max(24, Math.floor(room * 0.55))
    ? normalized.slice(0, boundary)
    : normalized.slice(0, room);

  return {
    full_title: title,
    display_title: `${prefix.trimEnd()}${suffix}`,
    compacted: true,
    max_chars: maxChars,
    rule: boundary >= Math.max(24, Math.floor(room * 0.55)) ? "word_boundary_ellipsis" : "hard_boundary_ellipsis",
  };
}

export function taskReconciliationFacts(
  row: TaskRow,
  opts: { today?: string; nowEpochSeconds?: number; titleMaxChars?: number; staleAfterDays?: number } = {},
): TaskReconciliationFacts {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return {
    title: compactTaskTitle(row.title, opts.titleMaxChars ?? DEFAULT_TITLE_MAX),
    currentness: taskCurrentness(row, {
      today,
      nowEpochSeconds: opts.nowEpochSeconds,
      staleAfterDays: opts.staleAfterDays,
    }),
  };
}

export function taskCurrentness(
  row: TaskRow,
  opts: { today: string; nowEpochSeconds?: number; staleAfterDays?: number },
): TaskCurrentness {
  const facts = extractTaskScheduleFacts(row);
  const band = classifyTaskBand(facts, opts.today);
  const evidence: string[] = [];
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const nowEpochSeconds = opts.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const ageDays = Math.max(0, Math.floor((nowEpochSeconds - row.updated_at) / 86_400));

  if (facts.archived) {
    return finish("archived", "done", "none", false, null, false, "none", ["archived marker present"], band);
  }
  if (facts.done) {
    return finish("done", "done", "none", false, null, false, "none", ["task is terminal"], band);
  }

  if (facts.due_iso && facts.due_iso < opts.today) {
    evidence.push(`due ${facts.due_iso} before ${opts.today}`);
    return finish("stale", "stale", "now", true, "past_due", true, "review_stale", evidence, band);
  }

  if (!row.owner) {
    evidence.push("open task has no owner");
    return finish("needs_chris", "needs_approval", urgencyForBand(band), false, null, true, "assign_owner", evidence, band);
  }

  if (row.status === "doing" && ageDays >= staleAfterDays) {
    evidence.push(`doing with no update for ${ageDays} days`);
    return finish("blocked", "blocked_or_failed", "now", true, "doing_stale", true, "resume_or_close", evidence, band);
  }

  if (ageDays >= staleAfterDays * 2) {
    evidence.push(`open with no update for ${ageDays} days`);
    return finish("stale", "stale", urgencyForBand(band), true, "inactive", true, "review_stale", evidence, band);
  }

  evidence.push("open, assigned, and within currentness threshold");
  return finish("current", "actionable_ready", urgencyForBand(band), false, null, false, "none", evidence, band);
}

export function summarizeTaskReconciliation(
  rows: readonly TaskRow[],
  opts: { today: string; nowEpochSeconds?: number; staleAfterDays?: number } = { today: new Date().toISOString().slice(0, 10) },
): TaskReconciliationSummary {
  const summary: TaskReconciliationSummary = {
    actionable_ready: 0,
    needs_approval: 0,
    stale: 0,
    duplicate_or_noop: 0,
    blocked_or_failed: 0,
    done: 0,
  };

  for (const row of rows) {
    const currentness = taskCurrentness(row, opts);
    summary[currentness.bucket] += 1;
  }
  return summary;
}

function urgencyForBand(band: TaskBandKind): TaskCurrentness["urgency"] {
  if (band === "overdue") return "now";
  if (band === "today" || band === "high_no_due") return "today";
  if (band === "tomorrow") return "soon";
  if (band === "done") return "none";
  return "later";
}

function finish(
  state: TaskCurrentnessState,
  bucket: TaskReviewBucket,
  urgency: TaskCurrentness["urgency"],
  stale: boolean,
  staleReason: string | null,
  needsChris: boolean,
  proposedAction: TaskCurrentness["proposed_action"],
  evidence: string[],
  band: TaskBandKind,
): TaskCurrentness {
  return {
    state,
    bucket,
    band,
    urgency,
    stale,
    stale_reason: staleReason,
    needs_chris: needsChris,
    proposed_action: proposedAction,
    evidence,
  };
}
