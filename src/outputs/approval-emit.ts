// Kapelle P3 — manager-side approval emit producer (2026-06-09).
//
// When an operator approves a reviewed artifact via the canonical
// POST /artifacts/:id/approve endpoint, this module emits the
// downstream manager-visible task that carries the structured approval
// payload Regina's /ops decisions queue (OP-1) reads from.
//
// Idempotency: one task per artifact_id. The task name is a
// deterministic hash of the artifact id, so re-approve returns the
// pre-existing row instead of creating a second one. Mirrors the
// existing first-approve-wins semantics on artifact_review_state.
//
// Failure shape: every non-OK return is a typed `{ kind, message,
// retry_with }` so the caller can surface the exact retry payload to
// the operator. `tasks_repository` covers DB-side failures, `validation`
// covers malformed input, and `team_resolution` covers the "no
// team_id" path. The route handler decides whether to fail the whole
// request or include the structured error alongside the successful
// approval state — see routes.ts.
//
// Schema versioning: the task description carries
// `schema_version: "artifact.approval.v1"` inside a fenced JSON block.
// Regina's decisions adapter parses this. Adding new fields is
// backwards-compatible; renaming or removing one is a breaking change.

import { createHash } from "node:crypto";
import type { DbAdapter } from "../db/db-adapter.js";
import type { TasksRepository } from "../db/db-service.js";
import type { TaskRow } from "../db/types.js";
import { buildTaskRow, draftFromDispatchApproval } from "../tasks-readmodel/task-draft.js";

export const APPROVAL_PAYLOAD_SCHEMA_VERSION = "artifact.approval.v1" as const;
export const APPROVAL_TASK_NAME_PREFIX = "artifact-approval-" as const;

export interface ApprovalReviewer {
  kind: "human" | "agent" | "system";
  id: string;
  label?: string;
}

export type ApprovalState = "approved" | "rejected" | "redirected";

export interface ApprovalEmitInput {
  artifact_id: string;
  reviewer: ApprovalReviewer;
  approval_state: ApprovalState;
  source_surface: string;
  approved_at: string;
  op_id: number;
  approval_note: string | null;
  team_id: string;
}

export interface ApprovalPayload {
  schema_version: typeof APPROVAL_PAYLOAD_SCHEMA_VERSION;
  artifact_id: string;
  reviewer: ApprovalReviewer;
  approval_state: ApprovalState;
  source_surface: string;
  approved_at: string;
  op_id: number;
  approval_note: string | null;
}

export type ApprovalEmitErrorKind =
  | "validation"
  | "tasks_repository"
  | "team_resolution";

export interface ApprovalEmitError {
  kind: ApprovalEmitErrorKind;
  message: string;
  retry_with?: {
    method: "POST";
    url: string;
    body: Record<string, unknown>;
  };
}

export type ApprovalEmitResult =
  | { ok: true; task: TaskRow; idempotent: boolean }
  | { ok: false; error: ApprovalEmitError };

export interface EmitApprovalTaskOptions {
  adapter: DbAdapter;
  tasks: TasksRepository;
  input: ApprovalEmitInput;
  now?: () => Date;
}

export function approvalTaskName(artifactId: string): string {
  const digest = createHash("sha256").update(artifactId).digest("hex").slice(0, 12);
  return `${APPROVAL_TASK_NAME_PREFIX}${digest}`;
}

export async function emitApprovalTask(
  opts: EmitApprovalTaskOptions,
): Promise<ApprovalEmitResult> {
  const validation = validateInput(opts.input);
  if (validation) return { ok: false, error: validation };

  const taskName = approvalTaskName(opts.input.artifact_id);
  const existing = await opts.tasks
    .getByNameForTeam(taskName, opts.input.team_id)
    .catch((err: unknown) => {
      return { __error__: err };
    });

  if (existing && typeof existing === "object" && "__error__" in existing) {
    return tasksRepoFailure(existing.__error__, opts.input);
  }
  if (existing) {
    return { ok: true, task: existing as TaskRow, idempotent: true };
  }

  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  // tasks.created_by REFERENCES agents(id); the manager service is not a
  // registered agent, so created_by stays NULL (the "creator" trace lives in
  // the description payload's schema_version + the artifact_operations op_id
  // link). buildTaskRow converges this source onto the canonical schema —
  // epoch-SECONDS timestamps + `task_<ms>_<rand>` id (it previously wrote ms +
  // a bare UUID, the lone drift the read-model only tolerated by accident).
  const row: TaskRow = buildTaskRow(
    draftFromDispatchApproval({
      name: taskName,
      team_id: opts.input.team_id,
      title: taskTitle(opts.input),
      description: taskDescription(opts.input),
    }),
    { nowMs },
  );

  try {
    await opts.tasks.create(row);
  } catch (err) {
    return tasksRepoFailure(err, opts.input);
  }

  return { ok: true, task: row, idempotent: false };
}

export function parseApprovalPayload(description: string): ApprovalPayload | null {
  if (!description) return null;
  const match = description.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] ?? "");
    if (!isApprovalPayload(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validateInput(input: ApprovalEmitInput): ApprovalEmitError | null {
  if (!input.artifact_id || typeof input.artifact_id !== "string") {
    return {
      kind: "validation",
      message: "approval emit: artifact_id is required",
      retry_with: {
        method: "POST",
        url: "/artifacts/<artifact_id>/approve",
        body: { ...input },
      },
    };
  }
  if (!input.reviewer || !input.reviewer.id) {
    return {
      kind: "validation",
      message: "approval emit: reviewer.id is required",
      retry_with: {
        method: "POST",
        url: `/artifacts/${input.artifact_id}/approve`,
        body: { ...input },
      },
    };
  }
  if (!input.team_id) {
    return {
      kind: "team_resolution",
      message: "approval emit: team_id could not be resolved",
      retry_with: {
        method: "POST",
        url: `/artifacts/${input.artifact_id}/approve`,
        body: { ...input },
      },
    };
  }
  if (!input.approved_at || !input.source_surface) {
    return {
      kind: "validation",
      message: "approval emit: approved_at and source_surface are required",
      retry_with: {
        method: "POST",
        url: `/artifacts/${input.artifact_id}/approve`,
        body: { ...input },
      },
    };
  }
  return null;
}

function taskTitle(input: ApprovalEmitInput): string {
  const reviewerLabel = input.reviewer.label || input.reviewer.id;
  return `Artifact approved: ${input.artifact_id} by ${reviewerLabel}`;
}

function taskDescription(input: ApprovalEmitInput): string {
  const payload: ApprovalPayload = {
    schema_version: APPROVAL_PAYLOAD_SCHEMA_VERSION,
    artifact_id: input.artifact_id,
    reviewer: input.reviewer,
    approval_state: input.approval_state,
    source_surface: input.source_surface,
    approved_at: input.approved_at,
    op_id: input.op_id,
    approval_note: input.approval_note,
  };
  const reviewerLabel = input.reviewer.label || input.reviewer.id;
  return [
    "# Approval-emitted task",
    "",
    "This task was created when a reviewed artifact was approved via the manager-side",
    "P3 emit path (Kapelle 2026-06-09). It is the canonical downstream record of the",
    "approval; Regina's `/ops` decisions queue reads the JSON payload below.",
    "",
    "## Approval",
    "",
    `- artifact_id: \`${input.artifact_id}\``,
    `- reviewer: \`${reviewerLabel}\` (\`${input.reviewer.kind}:${input.reviewer.id}\`)`,
    `- approval_state: \`${input.approval_state}\``,
    `- source_surface: \`${input.source_surface}\``,
    `- approved_at: \`${input.approved_at}\``,
    `- op_id: \`${input.op_id}\``,
    "",
    "## Payload",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n");
}

function tasksRepoFailure(err: unknown, input: ApprovalEmitInput): ApprovalEmitResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: {
      kind: "tasks_repository",
      message: `approval emit: tasks repository failure: ${message}`,
      retry_with: {
        method: "POST",
        url: `/artifacts/${input.artifact_id}/approve`,
        body: {
          approver: input.reviewer.id,
          source_surface: input.source_surface,
          note: input.approval_note,
        },
      },
    },
  };
}

function isApprovalPayload(value: unknown): value is ApprovalPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== APPROVAL_PAYLOAD_SCHEMA_VERSION) return false;
  if (typeof v.artifact_id !== "string") return false;
  if (typeof v.source_surface !== "string") return false;
  if (typeof v.approved_at !== "string") return false;
  if (typeof v.op_id !== "number") return false;
  const reviewer = v.reviewer;
  if (!reviewer || typeof reviewer !== "object") return false;
  const r = reviewer as Record<string, unknown>;
  if (typeof r.id !== "string") return false;
  if (r.kind !== "human" && r.kind !== "agent" && r.kind !== "system") return false;
  if (v.approval_state !== "approved" && v.approval_state !== "rejected" && v.approval_state !== "redirected") {
    return false;
  }
  return true;
}
