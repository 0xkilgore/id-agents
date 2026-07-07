import crypto from "crypto";
import type { AgentRow, TaskRow } from "../db/types.js";
import type { TaskNoteEventRow } from "../task-notes/storage.js";

export type TaskTriageClassification =
  | "route_to_project_agent"
  | "archive_done"
  | "needs_chris"
  | "stale_defer"
  | "duplicate_superseded";

export interface TaskNoteSignal {
  item_id: string;
  task_ref: string;
  task_uuid: string | null;
  task_title: string;
  note_text: string;
  description_line: number;
  source_surface: "manager_task_description" | "task_note_event";
  provenance: {
    task_name: string | null;
    task_uuid: string | null;
    task_updated_at?: number;
    task_note_id?: string;
    task_note_status?: string;
    source_field: "tasks.description" | "task_note_events.note_body";
    source_line: number;
  };
}

export interface TaskTriageItem extends TaskNoteSignal {
  classification: TaskTriageClassification;
  confidence: "high" | "medium" | "low";
  deterministic_safe: boolean;
  proposed_action: string;
  target_agent: string | null;
  reasons: string[];
  console_lane: "auto_routed" | "needs_chris" | "deferred" | "closed";
}

export interface TaskTriageReview {
  schema_version: "task-triage-review.v1";
  generated_at: string;
  source: {
    manager_tasks: number;
    task_notes: number;
    inbox_digest: "excluded";
  };
  summary: Record<TaskTriageClassification, number> & {
    auto_route_candidates: number;
    console_lane_items: number;
  };
  items: TaskTriageItem[];
}

const OPEN_TASK_STATUSES = new Set(["todo", "doing"]);

const DONE_PATTERNS = [
  /\b(done|completed|finished|shipped|landed|closed|resolved)\b/i,
  /\barchive\b/i,
];

const DUPLICATE_PATTERNS = [
  /\bduplicate\b/i,
  /\bsuperseded\b/i,
  /\breplaced by\b/i,
  /\bsame as\b/i,
];

const NEEDS_CHRIS_PATTERNS = [
  /\bneeds? chris\b/i,
  /\bask chris\b/i,
  /\bchris should\b/i,
  /\bwaiting on chris\b/i,
  /\bapproval\b/i,
  /\bdecide\b/i,
];

const DEFER_PATTERNS = [
  /\bstale\b/i,
  /\bdefer\b/i,
  /\bsnooze\b/i,
  /\blater\b/i,
  /\bnot now\b/i,
];

const ROUTE_PATTERNS = [
  /\broute (?:to|back to)\s+([a-z0-9][a-z0-9_-]*)\b/i,
  /\bassign (?:to|back to)\s+([a-z0-9][a-z0-9_-]*)\b/i,
  /\b(?:ask|tell|ping|have)\s+([a-z0-9][a-z0-9_-]*)\s+(?:to|for)\b/i,
  /\b([a-z0-9][a-z0-9_-]*)\s+agent\b/i,
  /@([a-z0-9][a-z0-9_-]*)\b/i,
];

const AGENT_ALIAS_HINTS: Array<[RegExp, string]> = [
  [/\bpersonal\b|\bterm[- ]?life\b|\blife insurance\b|\binsurance\b|\bhealth\b/i, "personal"],
  [/\bfinance\b|\btax\b|\bbank\b|\bcard\b|\bstatement\b/i, "finance"],
  [/\bfrontend\b|\bui\b|\bconsole\b|\bkapelle-site\b/i, "frontend"],
  [/\bsubstrate\b|\bmanager\b|\bapi\b|\bid-agents\b|\bbackend\b/i, "roger"],
  [/\bverify\b|\bverification\b|\bqa\b|\bacceptance\b/i, "gaudi"],
];

function stableId(task: TaskRow, line: number, text: string): string {
  const hash = crypto
    .createHash("sha256")
    .update([task.uuid || task.id, String(line), text.trim()].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `tasknote_${hash}`;
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, "");
}

function agentLookup(agents: AgentRow[]): Map<string, AgentRow> {
  const map = new Map<string, AgentRow>();
  for (const agent of agents) {
    map.set(normalizeAgentName(agent.name), agent);
    map.set(normalizeAgentName(agent.id), agent);
    const alias = (agent.metadata as any)?.alias;
    if (typeof alias === "string" && alias.trim()) {
      map.set(normalizeAgentName(alias), agent);
    }
  }
  return map;
}

function resolveMentionedAgent(text: string, agents: AgentRow[]): { agent: AgentRow | null; reason: string | null } {
  const lookup = agentLookup(agents);
  for (const pattern of ROUTE_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const found = lookup.get(normalizeAgentName(match[1]));
    if (found) return { agent: found, reason: `explicit agent reference: ${match[1]}` };
  }

  for (const [pattern, target] of AGENT_ALIAS_HINTS) {
    if (!pattern.test(text)) continue;
    const found = lookup.get(target);
    if (found) return { agent: found, reason: `domain keyword matched ${target}` };
  }

  return { agent: null, reason: null };
}

export function extractTaskNoteSignals(task: TaskRow): TaskNoteSignal[] {
  if (!OPEN_TASK_STATUSES.has(task.status)) return [];
  const lines = (task.description ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text }) => text.length > 0);

  return lines.map(({ line, text }) => ({
    item_id: stableId(task, line, text),
    task_ref: task.name,
    task_uuid: task.uuid,
    task_title: task.title,
    note_text: text,
    description_line: line,
    source_surface: "manager_task_description",
    provenance: {
      task_name: task.name,
      task_uuid: task.uuid,
      task_updated_at: task.updated_at,
      source_field: "tasks.description",
      source_line: line,
    },
  }));
}

export function taskNoteEventToSignal(note: TaskNoteEventRow, task: TaskRow | null): TaskNoteSignal {
  return {
    item_id: note.note_id,
    task_ref: note.task_name ?? note.task_ref,
    task_uuid: note.task_uuid ?? task?.uuid ?? null,
    task_title: task?.title ?? note.task_name ?? note.task_ref,
    note_text: note.note_body,
    description_line: note.line_number ?? 1,
    source_surface: "task_note_event",
    provenance: {
      task_name: note.task_name ?? task?.name ?? null,
      task_uuid: note.task_uuid ?? task?.uuid ?? null,
      task_updated_at: task?.updated_at,
      task_note_id: note.note_id,
      task_note_status: note.routing_status,
      source_field: "task_note_events.note_body",
      source_line: note.line_number ?? 1,
    },
  };
}

export function classifyTaskNote(signal: TaskNoteSignal, agents: AgentRow[]): TaskTriageItem {
  const text = signal.note_text;
  const route = resolveMentionedAgent(text, agents);
  const reasons: string[] = [];

  if (route.agent) {
    reasons.push(route.reason ?? "agent route matched");
    return {
      ...signal,
      classification: "route_to_project_agent",
      confidence: "high",
      deterministic_safe: true,
      proposed_action: `Route task note to ${route.agent.name}`,
      target_agent: route.agent.name,
      reasons,
      console_lane: "auto_routed",
    };
  }

  if (DUPLICATE_PATTERNS.some((pattern) => pattern.test(text))) {
    reasons.push("duplicate/superseded language");
    return {
      ...signal,
      classification: "duplicate_superseded",
      confidence: "medium",
      deterministic_safe: false,
      proposed_action: "Surface for Chris to confirm duplicate/superseded handling",
      target_agent: null,
      reasons,
      console_lane: "needs_chris",
    };
  }

  if (DONE_PATTERNS.some((pattern) => pattern.test(text))) {
    reasons.push("done/archive language");
    return {
      ...signal,
      classification: "archive_done",
      confidence: "medium",
      deterministic_safe: false,
      proposed_action: "Surface for Chris to confirm task can be archived/done",
      target_agent: null,
      reasons,
      console_lane: "needs_chris",
    };
  }

  if (NEEDS_CHRIS_PATTERNS.some((pattern) => pattern.test(text))) {
    reasons.push("Chris decision/approval language");
    return {
      ...signal,
      classification: "needs_chris",
      confidence: "medium",
      deterministic_safe: false,
      proposed_action: "Show in task triage lane for Chris decision",
      target_agent: null,
      reasons,
      console_lane: "needs_chris",
    };
  }

  if (DEFER_PATTERNS.some((pattern) => pattern.test(text))) {
    reasons.push("stale/defer language");
    return {
      ...signal,
      classification: "stale_defer",
      confidence: "low",
      deterministic_safe: false,
      proposed_action: "Defer until a stronger routing or closure signal appears",
      target_agent: null,
      reasons,
      console_lane: "deferred",
    };
  }

  return {
    ...signal,
    classification: "needs_chris",
    confidence: "low",
    deterministic_safe: false,
    proposed_action: "Unclassified task note; show in task triage lane",
    target_agent: null,
    reasons: ["no deterministic route/closure/defer rule matched"],
    console_lane: "needs_chris",
  };
}

export function buildTaskTriageReview(input: {
  tasks: TaskRow[];
  agents: AgentRow[];
  taskNotes?: TaskNoteEventRow[];
  nowIso?: string;
}): TaskTriageReview {
  const tasksByUuid = new Map(input.tasks.map((task) => [task.uuid, task]));
  const tasksByName = new Map(input.tasks.map((task) => [task.name, task]));
  const eventSignals = (input.taskNotes ?? []).map((note) =>
    taskNoteEventToSignal(
      note,
      (note.task_uuid ? tasksByUuid.get(note.task_uuid) : undefined) ??
        (note.task_name ? tasksByName.get(note.task_name) : undefined) ??
        tasksByName.get(note.task_ref) ??
        null,
    ),
  );
  const signals = [...input.tasks.flatMap(extractTaskNoteSignals), ...eventSignals];
  const items = signals.map((signal) => classifyTaskNote(signal, input.agents));
  const summary = {
    route_to_project_agent: 0,
    archive_done: 0,
    needs_chris: 0,
    stale_defer: 0,
    duplicate_superseded: 0,
    auto_route_candidates: 0,
    console_lane_items: 0,
  };

  for (const item of items) {
    summary[item.classification] += 1;
    if (item.deterministic_safe && item.target_agent) summary.auto_route_candidates += 1;
    if (item.console_lane === "needs_chris") summary.console_lane_items += 1;
  }

  return {
    schema_version: "task-triage-review.v1",
    generated_at: input.nowIso ?? new Date().toISOString(),
    source: {
      manager_tasks: input.tasks.length,
      task_notes: signals.length,
      inbox_digest: "excluded",
    },
    summary,
    items,
  };
}

export function taskNoteDispatchMessage(item: TaskTriageItem): string {
  return [
    `Task note routed by task triage loop.`,
    ``,
    `Task: ${item.task_title} (${item.task_ref})`,
    `Classification: ${item.classification}`,
    `Source: ${item.source_surface} line ${item.description_line}`,
    ``,
    `Note:`,
    item.note_text,
    ``,
    `Provenance: ${JSON.stringify(item.provenance)}`,
  ].join("\n");
}
