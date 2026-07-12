import { loopPhidForSlug } from "./registry.js";
import { loopRunPhid } from "./storage.js";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  getBacklogItem,
  getBacklogItemByLogicalKey,
  insertBacklogItem,
} from "../continuous-orchestration/storage.js";
import type { BacklogItem } from "../continuous-orchestration/types.js";
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

export interface WorktreeHygieneCleanupRoute {
  dedupe_key: string;
  logical_key: string;
  task_name: string;
  owner_lane: string;
  cleanup_dispatch_id: string | null;
  item: BacklogItem;
  created: boolean;
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
  } else if (/missing clean promotion path|no clean promotion path|clean promotion path missing|cannot find clean promotion path/.test(text)) {
    incident_code = "missing_clean_promotion_path";
    action = "create_or_update_hygiene_task";
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

export function hygieneOwnerLane(repo: string): string {
  const r = repo.toLowerCase();
  if (/(kapelle-site|frontend|console|ui)(\/|$)/.test(r)) return "frontend-ui-codex";
  if (/(id-agents|agent-platform|manager|substrate|cane)(\/|$)/.test(r)) return "substrate-api-codex";
  return "roger";
}

export async function upsertWorktreeHygieneCleanupRoute(
  adapter: DbAdapter,
  incident: WorktreeHygieneIncident,
  opts: { team_id?: string; nowIso?: string } = {},
): Promise<WorktreeHygieneCleanupRoute> {
  const teamId = opts.team_id ?? "default";
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const dedupeKey = hygieneDedupeKey(incident);
  const logicalKey = `worktree-hygiene:${dedupeKey}`;
  const ownerLane = hygieneOwnerLane(incident.repo);
  const taskName = hygieneTaskName(incident);
  const title = `Worktree hygiene: ${incident.incident_code} on ${incident.branch}`;
  const dispatchBody = [
    `[project: kapelle][T-OPRESET][HYGIENE] ${ownerLane}: Resolve Worktree Hygiene cleanup route.`,
    ``,
    `Dedupe key: ${dedupeKey}`,
    `Repo: ${incident.repo}`,
    `Branch: ${incident.branch}`,
    `Class: ${incident.incident_code}`,
    `Recommended action: ${incident.action}`,
    incident.linked_dispatch ? `Linked dispatch: ${incident.linked_dispatch}` : null,
    incident.linked_task ? `Linked task: ${incident.linked_task}` : null,
    incident.detail ? `Evidence: ${incident.detail}` : null,
    ``,
    `Preserve product blocker visibility, but own the cleanup in this lane. Update the same route on repeated failures; do not create duplicate cleanup work.`,
  ].filter((line): line is string => line != null).join("\n");

  const existing = await getBacklogItemByLogicalKey(adapter, teamId, logicalKey);
  if (existing) {
    await adapter.query(
      `UPDATE orchestration_backlog_item
          SET title = $1,
              track = $2,
              to_agent = $3,
              dispatch_body = $4,
              priority = $5,
              risk_class = $6,
              source_refs_json = $7,
              updated_by = $8,
              updated_at = $9
        WHERE item_id = $10`,
      [
        title,
        "T-OPRESET",
        ownerLane,
        dispatchBody,
        3,
        "routine",
        JSON.stringify(sourceRefsForIncident(incident, dedupeKey)),
        "worktree-hygiene-router",
        nowIso,
        existing.item_id,
      ],
    );
    const item = await getBacklogItem(adapter, existing.item_id);
    return {
      dedupe_key: dedupeKey,
      logical_key: logicalKey,
      task_name: taskName,
      owner_lane: ownerLane,
      cleanup_dispatch_id: item?.last_dispatch_phid ?? existing.last_dispatch_phid,
      item: item ?? existing,
      created: false,
    };
  }

  const item = await insertBacklogItem(adapter, {
    team_id: teamId,
    logical_key: logicalKey,
    title,
    track: "T-OPRESET",
    to_agent: ownerLane,
    dispatch_body: dispatchBody,
    priority: 3,
    readiness_state: "ready",
    risk_class: "routine",
    source_refs: sourceRefsForIncident(incident, dedupeKey),
  });
  return {
    dedupe_key: dedupeKey,
    logical_key: logicalKey,
    task_name: taskName,
    owner_lane: ownerLane,
    cleanup_dispatch_id: item.last_dispatch_phid,
    item,
    created: true,
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

export function buildScheduledWorktreeHygieneRun(
  loop: Pick<LoopRecord, "loop_phid">,
  input: {
    recurrence_phid: string;
    scheduled_for: string;
    recurrence_instance_phid?: string | null;
    fired_at?: string | null;
    actor?: ActorRef | null;
  },
): LoopRunRecord {
  const firedAt = input.fired_at ?? input.scheduled_for;
  const idempotencyKey = `scheduled:${input.scheduled_for}`;
  const actor = input.actor ?? { kind: "system", id: "manager-recurring-loop", label: "Manager Recurring Loop" };
  const trigger: Extract<LoopTrigger, { kind: "scheduled" }> = {
    kind: "scheduled",
    recurrence_phid: input.recurrence_phid,
    recurrence_instance_phid: input.recurrence_instance_phid ?? null,
    scheduled_for: input.scheduled_for,
    dedup_key: idempotencyKey,
  };
  return {
    loop_run_phid: loopRunPhid(loop.loop_phid, idempotencyKey),
    loop_phid: loop.loop_phid,
    trigger,
    status: "queued",
    failure_reason: null,
    failure_detail: null,
    step_log: [
      {
        step_id: "worktree-hygiene-scheduled-admission",
        phase: "admission",
        name: "scheduled worktree hygiene admitted",
        status: "succeeded",
        started_at: firedAt,
        finished_at: firedAt,
        failure_reason: null,
        detail: "Manager-owned recurring Worktree Hygiene guard run; scanner/runtime state is supplied by durable loop evidence, not LLM memory.",
        evidence_refs: [
          { kind: "loop", ref: loop.loop_phid },
          { kind: "recurrence", ref: input.recurrence_phid },
          { kind: "scheduled_for", ref: input.scheduled_for },
          ...(input.recurrence_instance_phid ? [{ kind: "recurrence_instance", ref: input.recurrence_instance_phid }] : []),
        ],
      },
    ],
    output_refs: [],
    spawned_dispatch_phids: [],
    idempotency_key: idempotencyKey,
    retry_of_phid: null,
    fired_at: firedAt,
    queued_at: firedAt,
    admitted_at: null,
    started_at: null,
    finished_at: null,
    created_by: actor,
    updated_at: firedAt,
  };
}

function sourceRefsForIncident(incident: WorktreeHygieneIncident, dedupeKey: string): string[] {
  return [
    `worktree-hygiene:${dedupeKey}`,
    ...(incident.linked_dispatch ? [`dispatch:${incident.linked_dispatch}`] : []),
    ...(incident.linked_task ? [`task:${incident.linked_task}`] : []),
    ...(incident.linked_rd ? [`rd:${incident.linked_rd}`] : []),
  ];
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
