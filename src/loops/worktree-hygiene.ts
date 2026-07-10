import { loopPhidForSlug } from "./registry.js";
import { loopRunPhid } from "./storage.js";
import type {
  ActorRef,
  LoopRecord,
  LoopRunRecord,
  LoopStepLog,
  LoopTrigger,
  WorktreeHygieneAction,
  WorktreeHygieneIncidentCode,
} from "./types.js";

export const WORKTREE_HYGIENE_SLUG = "worktree-hygiene";
export const WORKTREE_HYGIENE_LOOP_PHID = loopPhidForSlug(WORKTREE_HYGIENE_SLUG);

export interface WorktreeHygieneIncident {
  repo: string;
  branch: string;
  incident_code: WorktreeHygieneIncidentCode;
  linked_task: string | null;
  linked_dispatch: string | null;
  linked_rd: string | null;
  action: WorktreeHygieneAction;
  detail: string | null;
}

export interface StaleBaseAdmissionInput {
  repo: string;
  branch: string;
  base_ref?: string | null;
  behind?: number | null;
  threshold?: number | null;
  linked_task?: string | null;
  linked_dispatch?: string | null;
  linked_rd?: string | null;
}

export interface WorktreeHygieneNeedsOperatorInput {
  emit: boolean;
  question: string | null;
  recommended_option: string | null;
  options: string[];
}

export function hygieneDedupeKey(input: {
  repo: string;
  branch: string;
  incident_code: WorktreeHygieneIncidentCode;
}): string {
  return `${normalizeRepo(input.repo)}:${normalizeBranch(input.branch)}:${input.incident_code}`;
}

export function hygieneTaskName(input: {
  repo: string;
  branch: string;
  incident_code: WorktreeHygieneIncidentCode;
}): string {
  const repo = normalizeRepo(input.repo).split("/").filter(Boolean).pop() ?? "repo";
  const branch = normalizeBranch(input.branch).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `worktree-hygiene-${slugPart(repo)}-${slugPart(branch)}-${input.incident_code.replaceAll("_", "-")}`;
}

export function classifyPromotionHygieneFailure(input: {
  repo?: string | null;
  branch?: string | null;
  dispatch_id?: string | null;
  task?: string | null;
  rd?: string | null;
  text?: string | null;
  payload?: unknown;
}): WorktreeHygieneIncident | null {
  const text = `${input.text ?? ""}\n${stringifyLoose(input.payload)}`.toLowerCase();
  const repo = input.repo ?? extractString(input.payload, ["repo", "path"]) ?? "unknown-repo";
  const branch = input.branch ?? extractString(input.payload, ["branch", "source_branch"]) ?? "unknown-branch";
  let incident_code: WorktreeHygieneIncidentCode | null = null;
  let action: WorktreeHygieneAction = "route_to_worktree_hygiene";

  if (/\bahead\s*=\s*\d+.*\bbehind\s*=\s*\d+|\bbehind\s*=\s*\d+.*\bahead\s*=\s*\d+|ahead\/behind|has diverged|divergent/.test(text)) {
    incident_code = "ahead_behind_divergence";
    action = "create_fresh_branch_from_base";
  } else if (/dirty primary|primary checkout.*dirty/.test(text)) {
    incident_code = "dirty_primary_checkout";
    action = "inventory_and_preserve_dirty_paths";
  } else if (/working tree has unapproved dirty paths|dirty checkout|dirty working tree|uncommitted changes/.test(text)) {
    incident_code = "dirty_checkout";
    action = "inventory_and_preserve_dirty_paths";
  } else if (/stale base|behind origin\/main|behind .*base|fetch.*base.*failed/.test(text)) {
    incident_code = "stale_base";
    action = "create_fresh_branch_from_base";
  } else if (/branch .*held by.*worktree|already checked out|is already used by worktree|worktree.*holds.*branch/.test(text)) {
    incident_code = "branch_held_by_worktree";
    action = "use_clean_clone_or_worktree";
  } else if (/unlinked branch|no linked dispatch|no linked rd|no linked task|without linked dispatch/.test(text)) {
    incident_code = "unlinked_branch";
    action = "link_or_retire_branch";
  }

  if (!incident_code) return null;
  return {
    repo,
    branch,
    incident_code,
    linked_task: input.task ?? null,
    linked_dispatch: input.dispatch_id ?? null,
    linked_rd: input.rd ?? null,
    action,
    detail: firstLine(input.text) ?? null,
  };
}

export function classifyStaleBaseAdmission(input: StaleBaseAdmissionInput): WorktreeHygieneIncident | null {
  const behind = Math.max(0, Number(input.behind ?? 0));
  const threshold = Math.max(0, Number(input.threshold ?? 20));
  if (behind <= threshold) return null;

  const baseRef = input.base_ref?.trim() || "origin/main";
  return {
    repo: input.repo,
    branch: input.branch,
    incident_code: "stale_base",
    linked_task: input.linked_task ?? null,
    linked_dispatch: input.linked_dispatch ?? null,
    linked_rd: input.linked_rd ?? null,
    action: "create_fresh_branch_from_base",
    detail: `stale-base: branch ${input.branch} is ${behind} commits behind ${baseRef}; suggested remediation=fresh-branch-off-origin-main`,
  };
}

export function shouldEmitNeedsOperatorInput(input: {
  question?: string | null;
  options?: string[] | null;
  recommended_option?: string | null;
  unresolved_choice?: boolean | null;
}): WorktreeHygieneNeedsOperatorInput {
  const question = input.question?.trim() || null;
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  const recommended = input.recommended_option?.trim() || null;
  const emit = input.unresolved_choice === true && !!question && options.length >= 2 && !!recommended && options.includes(recommended);
  return {
    emit,
    question: emit ? question : null,
    recommended_option: emit ? recommended : null,
    options: emit ? options : [],
  };
}

export function buildPromotionHygieneRun(
  loop: Pick<LoopRecord, "loop_phid">,
  incident: WorktreeHygieneIncident,
  nowIso: string,
  opts: { source?: Extract<LoopTrigger, { kind: "promotion_hygiene" }>["source"]; actor?: ActorRef } = {},
): LoopRunRecord {
  const dedupeKey = hygieneDedupeKey(incident);
  const actor = opts.actor ?? { kind: "system", id: "worktree-hygiene-router", label: "Worktree Hygiene Router" };
  const trigger: Extract<LoopTrigger, { kind: "promotion_hygiene" }> = {
    kind: "promotion_hygiene",
    source: opts.source ?? "orchestration",
    repo: incident.repo,
    branch: incident.branch,
    incident_code: incident.incident_code,
    linked_task: incident.linked_task,
    linked_dispatch: incident.linked_dispatch,
    linked_rd: incident.linked_rd,
    action: incident.action,
    dedupe_key: dedupeKey,
    observed_at: nowIso,
  };
  const admissionStep: LoopStepLog = {
    step_id: "promotion-hygiene-route",
    phase: "admission",
    name: "promotion hygiene routed",
    status: "succeeded",
    started_at: nowIso,
    finished_at: nowIso,
    failure_reason: null,
    detail: incident.detail,
    evidence_refs: [
      { kind: "worktree_hygiene_dedupe", ref: dedupeKey },
      ...(incident.linked_dispatch ? [{ kind: "dispatch", ref: incident.linked_dispatch }] : []),
      ...(incident.linked_task ? [{ kind: "task", ref: incident.linked_task }] : []),
      ...(incident.linked_rd ? [{ kind: "rd", ref: incident.linked_rd }] : []),
    ],
  };
  return {
    loop_run_phid: loopRunPhid(loop.loop_phid, `promotion-hygiene:${dedupeKey}`),
    loop_phid: loop.loop_phid,
    trigger,
    status: "queued",
    failure_reason: null,
    failure_detail: null,
    step_log: [admissionStep],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: `promotion-hygiene:${dedupeKey}`,
    retry_of_phid: null,
    fired_at: nowIso,
    queued_at: nowIso,
    admitted_at: null,
    started_at: null,
    finished_at: null,
    created_by: actor,
    updated_at: nowIso,
  };
}

function normalizeRepo(repo: string): string {
  return repo.trim().replace(/\/+$/g, "") || "unknown-repo";
}

function normalizeBranch(branch: string): string {
  return branch.trim() || "unknown-branch";
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "x";
}

function stringifyLoose(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstLine(value: string | null | undefined): string | null {
  const line = value?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ?? null;
}
