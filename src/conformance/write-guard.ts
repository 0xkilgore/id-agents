import { parseProjectTag, parseTrackTag } from "../project-tracks/read-model.js";
import { projectFromPath } from "../outputs/entry-projection.js";
import { resolveTrack } from "../track-registry/registry.js";
import { RESET_CONFORMANT_DEFAULT_TRACK, hasNextActionText } from "../tasks-readmodel/task-draft.js";

export type WriteGuardKind = "task" | "dispatch" | "artifact" | "report";
export type WriteGuardDecision = "accepted" | "repaired" | "rejected";

export interface WriteGuardResult<T> {
  decision: WriteGuardDecision;
  value: T;
  repaired_fields: string[];
  rejected_fields: string[];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function conformantTrack(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  return resolveTrack(raw).conforms ? raw : null;
}

function nextActionLine(title: string, owner: string | null): string {
  return owner
    ? `Next action: ${owner} advances "${title.trim()}".`
    : `Next action: advance "${title.trim()}".`;
}

function appendNextAction(description: string | null | undefined, title: string, owner: string | null): string {
  const base = text(description);
  if (hasNextActionText(base)) return base!;
  const next = nextActionLine(title, owner);
  return base ? `${base}\n${next}` : next;
}

export function guardTaskCreate(input: {
  title: string;
  description: string | null;
  track: string | null;
  owner: string | null;
  created_by: string | null;
  owner_name?: string | null;
  team_id: string | null;
}): WriteGuardResult<{
  description: string;
  track: string;
  owner: string | null;
}> {
  const repaired_fields: string[] = [];
  const rejected_fields: string[] = [];

  const owner = text(input.owner) ?? text(input.created_by);
  if (!text(input.owner) && owner) repaired_fields.push("owner");
  if (!owner) rejected_fields.push("owner");

  let track = conformantTrack(input.track);
  if (!track) {
    track = RESET_CONFORMANT_DEFAULT_TRACK;
    repaired_fields.push("track");
  }
  if (!input.team_id) rejected_fields.push("project");

  const ownerLabel = text(input.owner_name) ?? owner;
  const description = appendNextAction(input.description, input.title, ownerLabel);
  if (description !== (text(input.description) ?? "")) repaired_fields.push("next_action");

  return {
    decision: rejected_fields.length > 0 ? "rejected" : repaired_fields.length > 0 ? "repaired" : "accepted",
    value: { description, track, owner },
    repaired_fields,
    rejected_fields,
  };
}

export function guardDispatchCreate(input: {
  subject: string | null;
  body_markdown: string;
  team_name?: string | null;
  to_agent: string;
}): WriteGuardResult<{ subject: string; body_markdown: string }> {
  const repaired_fields: string[] = [];
  const rejected_fields: string[] = [];
  const baseSubject = text(input.subject) ?? (input.body_markdown.slice(0, 80) || "Dispatch");
  let subject = baseSubject;
  let body = input.body_markdown;

  if (!parseProjectTag(subject) && !parseProjectTag(body) && !text(input.team_name)) {
    rejected_fields.push("project");
  }

  if (!conformantTrack(parseTrackTag(subject) ?? parseTrackTag(body))) {
    subject = `[${RESET_CONFORMANT_DEFAULT_TRACK}] ${subject}`;
    repaired_fields.push("track");
  }

  if (!hasNextActionText(body)) {
    body = appendNextAction(body, subject, input.to_agent);
    repaired_fields.push("next_action");
  }

  return {
    decision: rejected_fields.length > 0 ? "rejected" : repaired_fields.length > 0 ? "repaired" : "accepted",
    value: { subject, body_markdown: body },
    repaired_fields,
    rejected_fields,
  };
}

export function guardArtifactCreate(input: {
  basename: string;
  agent: string | null;
  tag?: string | null;
  abs_path: string;
  title?: string | null;
  project_ref?: string | null;
}): WriteGuardResult<{
  tag: string | null;
  title: string;
  project_ref: string | null;
}> {
  const repaired_fields: string[] = [];
  const rejected_fields: string[] = [];

  if (!text(input.agent)) rejected_fields.push("owner");

  let project_ref = text(input.project_ref) ?? projectFromPath(input.abs_path);
  if (!text(input.project_ref) && project_ref) repaired_fields.push("project");
  if (!project_ref) rejected_fields.push("project");

  let tag = text(input.tag);
  if (!conformantTrack(parseTrackTag(tag) ?? parseTrackTag(input.title) ?? parseTrackTag(input.basename))) {
    tag = tag ? `${tag} [${RESET_CONFORMANT_DEFAULT_TRACK}]` : `[${RESET_CONFORMANT_DEFAULT_TRACK}]`;
    repaired_fields.push("track");
  }

  let title = text(input.title);
  if (!title) {
    title = `Next action: review ${input.basename}`;
    repaired_fields.push("next_action");
  }

  return {
    decision: rejected_fields.length > 0 ? "rejected" : repaired_fields.length > 0 ? "repaired" : "accepted",
    value: { tag, title, project_ref },
    repaired_fields,
    rejected_fields,
  };
}
