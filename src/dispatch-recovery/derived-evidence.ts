// Derived landed-evidence for dispatches that died BEFORE /agent-done.
//
// Transport/expiry casualties never recorded an artifact_path or a promotion
// (the /agent-done callback was lost), so resolveLandedEvidence (which reads
// those columns) can't reconcile them — they stick at failed_needs_operator and
// pollute the operator's NEEDS-YOU queue even though the work LANDED.
//
// This module DERIVES the expected deliverable from the dispatch itself — an
// output path named in the body, or the track tag in the subject — and verifies
// it against disk/git, gated by the dispatch's claim window so attribution is
// sound. CONSERVATIVE: it only ever returns landed=true on positive evidence; it
// never invents a deliverable and never reclassifies a genuinely-failed dispatch.

import os from "node:os";

export interface DerivedRow {
  dispatch_phid: string;
  to_agent: string | null;
  subject: string | null;
  body_markdown: string | null;
  /** Lower bound of the claim window (the artifact/commit must be at/after this
   *  to be attributable to THIS dispatch). Usually started_at, else not_before_at. */
  window_start: string | null;
}

export interface RepoRef {
  path: string;
  base: string;
}

export interface DerivedProbes {
  /** Modified-time (epoch ms) of a file, or null when it does not exist. */
  fileMtimeMs: (path: string) => number | null;
  /** A commit SHA on origin/<base> of repo committed within [sinceMs, untilMs],
   *  or null. Agents' commit messages don't reference the dispatch/track, so for
   *  single-writer code lanes (only that agent commits to that repo) a commit in
   *  the dispatch window is the landed signal. Optional (commit evidence skipped
   *  when absent). */
  commitInWindow?: (repo: RepoRef, sinceMs: number, untilMs: number) => string | null;
}

/** How long after the dispatch start a landing commit may appear (one work session). */
const COMMIT_WINDOW_MS = 8 * 60 * 60 * 1000;

export interface DerivedEvidence {
  landed: boolean;
  kind: "artifact_present" | "commit_on_base" | "none";
  detail: string;
  evidence: string | null;
}

// Absolute/home paths ending in a known artifact extension.
const PATH_RE =
  /(?:^|[\s`"'(=])((?:~|\/Users\/[A-Za-z0-9._-]+)\/[A-Za-z0-9._/-]+\.(?:md|svg|csv|json|png|pdf|txt|html|tsx?|py))/g;

// Only DATED deliverable artifacts count — `.../<YYYY-MM-DD>-name.<ext>` in a
// report extension. This is the agent-deliverable signature; it deliberately
// excludes persistent tool/log/data files that a dispatch body merely
// REFERENCES (taskview.py, inbox.md, *-log.md, *.py) and that change constantly,
// which would otherwise false-positive on mtime alone.
const DELIVERABLE_RE = /\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+\.(?:md|svg|csv|pdf|html)$/;

function isDeliverablePath(p: string): boolean {
  return DELIVERABLE_RE.test(p);
}
// Track tags like T-CKPT.0, T15, T-ORCH.2, plus BUG-### / HC-##.
const TAG_RE = /\b(?:T-?(?:[A-Z]{1,6}|\d{1,3})(?:\.\d+)?|BUG-\d+|HC-\d+)\b/;
// 5-minute negative slack for clock skew between the agent host + manager clock.
const MTIME_SLACK_MS = 5 * 60 * 1000;

/** Extract candidate output paths named in the dispatch text (~ expanded). */
export function deriveExpectedArtifacts(
  texts: Array<string | null | undefined>,
  home = os.homedir(),
): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(PATH_RE)) {
      let p = m[1];
      if (p.startsWith("~")) p = home + p.slice(1);
      // Drop a trailing template token like {date}/{time} — unresolvable.
      if (/[{}<>]/.test(p)) continue;
      // Only DATED deliverable artifacts — never persistent tool/log files.
      if (!isDeliverablePath(p)) continue;
      out.add(p);
    }
  }
  return [...out];
}

/** The first track/bug/HC tag in the subject, or null. */
export function deriveTrackTag(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = subject.match(TAG_RE);
  return m ? m[0] : null;
}

/**
 * Resolve whether a no-evidence failed row's work demonstrably landed, by
 * deriving + verifying the expected deliverable. `agentRepos` maps an owner
 * agent to its single-writer repo for commit evidence.
 */
export function resolveDerivedLanded(
  row: DerivedRow,
  probes: DerivedProbes,
  agentRepos: Record<string, RepoRef> = {},
): DerivedEvidence {
  const startMs = row.window_start ? Date.parse(row.window_start) : NaN;
  const windowFloor = Number.isFinite(startMs) ? startMs - MTIME_SLACK_MS : null;

  // 1) A named artifact that exists AND was written within the claim window.
  for (const path of deriveExpectedArtifacts([row.subject, row.body_markdown])) {
    const mtime = safe(() => probes.fileMtimeMs(path));
    if (mtime === null || mtime === undefined) continue;
    if (windowFloor !== null && mtime < windowFloor) continue; // pre-dates the dispatch → not its output
    return {
      landed: true,
      kind: "artifact_present",
      detail: `named artifact present (mtime in window) at ${path}`,
      evidence: path,
    };
  }

  // 2) A commit on the owner agent's single-writer repo within the dispatch
  //    window (only that agent commits there, so a commit in-window = work landed).
  const repo = row.to_agent ? agentRepos[row.to_agent] : undefined;
  if (repo && probes.commitInWindow && Number.isFinite(startMs)) {
    const sha = safe(() => probes.commitInWindow!(repo, startMs - MTIME_SLACK_MS, startMs + COMMIT_WINDOW_MS));
    if (sha) {
      return {
        landed: true,
        kind: "commit_on_base",
        detail: `commit ${sha} on ${repo.path}@${repo.base} authored within the dispatch window`,
        evidence: sha,
      };
    }
  }

  return { landed: false, kind: "none", detail: "no derivable landed evidence", evidence: null };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ── Supersession ────────────────────────────────────────────────────
// Many recent casualties are explicit RE-FIREs ("AFTER the …", "RE-FIRE,
// consolidated"): the same work was re-dispatched and a LATER dispatch to the
// same agent for the same track reached a terminal SUCCESS. The earlier failed
// row is then moot — the work landed via the re-fire. This is a reliable signal
// for the verification/re-fire rows that carry no artifact or commit of their own.

export interface SupersessionProbe {
  /** A later dispatch_phid to `agent` whose subject carries `tag` that reached a
   *  terminal success after `afterMs`, or null. */
  laterSuccessForTag: (agent: string, tag: string, afterMs: number) => string | null;
}

export interface SupersessionEvidence {
  superseded: boolean;
  by: string | null;
  detail: string;
}

// ── Moot classification ─────────────────────────────────────────────
// A failed row is MOOT (not a genuine "fix me") when it died on INFRASTRUCTURE
// rather than the agent reporting a real problem: a scheduler wedge, a
// manager-to-agent transport-exhaustion (incl. the pre-66f4abe rate-limit
// MISLABEL), or a closeout/expiry stale-claim. A genuine "agent reported
// failure" is NEVER moot.

export interface MootRow {
  failure_kind: string | null;
  failure_detail: string | null;
  /** Used to gate the rate-limit mislabel against the 66f4abe transport fix. */
  updated_at: string | null;
}

export interface MootOptions {
  /** Epoch ms of the 66f4abe transport-classify fix. A
   *  provider_rate_limit_exhausted BEFORE this is a mislabeled
   *  transport-exhaustion (infra), not a real 429. */
  transportFixCutoffMs: number;
}

export interface MootEvidence {
  moot: boolean;
  reason: string;
}

// Closeout-expiry / stale-claim infra signatures on an agent_error row.
const INFRA_DETAIL_RE =
  /linked query terminated|stale in.?flight|expired|TTL cleanup|no progress evidence|Operator recovery|was block/i;

export function resolveMoot(row: MootRow, opts: MootOptions): MootEvidence {
  const kind = row.failure_kind ?? "";
  const detail = row.failure_detail ?? "";

  // A real agent-reported failure is never moot.
  if (/agent reported failure/i.test(detail)) {
    return { moot: false, reason: "agent reported a real failure — genuine" };
  }
  if (kind === "scheduler_wedged") {
    return { moot: true, reason: "scheduler wedge (in-flight infra death), not a task failure" };
  }
  if (kind === "agent_unreachable_exhausted") {
    return { moot: true, reason: "manager-to-agent transport exhaustion (infra), not a task failure" };
  }
  if (kind === "provider_rate_limit_exhausted") {
    const ts = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (Number.isFinite(ts) && ts < opts.transportFixCutoffMs) {
      return { moot: true, reason: "transport-exhaustion MISLABELED as rate-limit (predates the 66f4abe fix)" };
    }
    return { moot: false, reason: "post-66f4abe provider rate-limit — treat as genuine" };
  }
  if (kind === "agent_error" && INFRA_DETAIL_RE.test(detail)) {
    return { moot: true, reason: "closeout-expiry / stale-claim (infra death), not an agent-reported failure" };
  }
  return { moot: false, reason: "no moot signal" };
}

export function resolveSupersession(
  row: DerivedRow,
  probe: SupersessionProbe,
): SupersessionEvidence {
  const tag = deriveTrackTag(row.subject);
  const startMs = row.window_start ? Date.parse(row.window_start) : NaN;
  if (!tag || !row.to_agent || !Number.isFinite(startMs)) {
    return { superseded: false, by: null, detail: "no tag/agent/window for supersession" };
  }
  const by = safe(() => probe.laterSuccessForTag(row.to_agent!, tag, startMs));
  if (by) {
    return { superseded: true, by, detail: `superseded by later successful ${row.to_agent} dispatch ${by} for ${tag}` };
  }
  return { superseded: false, by: null, detail: "no later successful re-fire found" };
}
