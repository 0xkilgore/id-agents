import type { TaskRow } from "../db/types.js";

export type TaskPriority = "high" | "med" | "low" | null;
export type TaskBandKind = "overdue" | "today" | "tomorrow" | "high_no_due" | "later" | "done";

export interface TaskScheduleFacts {
  priority: TaskPriority;
  due_iso: string | null;
  done: boolean;
  archived: boolean;
}

export interface TaskBandSummary {
  total: number;
  open: number;
  overdue: number;
  today: number;
  tomorrow: number;
  high: number;
  high_no_due: number;
  later: number;
  done: number;
}

export interface TaskBand<T> {
  kind: Exclude<TaskBandKind, "done">;
  label: string;
  count: number;
  items: T[];
}

const PRIORITY_RE = /(?:^|\s)!(high|med|low)\b|(?:^|\s)(?:priority|prio|p):(high|med|low)\b/i;
const DUE_RE = /\bdue:(\d{4}-\d{2}-\d{2})\b/i;
const DONE_RE = /\bdone:\d{4}-\d{2}-\d{2}\b/i;
const ARCHIVED_RE = /\barchived:\d{4}-\d{2}-\d{2}\b/i;
const DEFAULT_TASK_TIMEZONE = "America/Chicago";

export function todayIso(now: Date = new Date(), timeZone: string = DEFAULT_TASK_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function extractTaskScheduleFacts(row: Pick<TaskRow, "title" | "description" | "status">): TaskScheduleFacts {
  const text = `${row.title}\n${row.description ?? ""}`;
  const priority = text.match(PRIORITY_RE);
  const due = text.match(DUE_RE);
  return {
    priority: ((priority?.[1] ?? priority?.[2])?.toLowerCase() as TaskPriority | undefined) ?? null,
    due_iso: due?.[1] ?? null,
    done: row.status === "done" || DONE_RE.test(text),
    archived: ARCHIVED_RE.test(text),
  };
}

export function classifyTaskBand(facts: TaskScheduleFacts, today: string): TaskBandKind {
  if (facts.done || facts.archived) return "done";
  if (facts.due_iso === null) return facts.priority === "high" ? "high_no_due" : "later";
  if (facts.due_iso < today) return "overdue";
  if (facts.due_iso === today) return "today";
  if (facts.due_iso === addDaysIso(today, 1)) return "tomorrow";
  return "later";
}

export function emptyTaskBandSummary(): TaskBandSummary {
  return {
    total: 0,
    open: 0,
    overdue: 0,
    today: 0,
    tomorrow: 0,
    high: 0,
    high_no_due: 0,
    later: 0,
    done: 0,
  };
}

export function summarizeTaskRows(rows: readonly TaskRow[], today: string): TaskBandSummary {
  const summary = emptyTaskBandSummary();
  summary.total = rows.length;

  for (const row of rows) {
    const facts = extractTaskScheduleFacts(row);
    const band = classifyTaskBand(facts, today);
    if (band === "done") {
      summary.done += 1;
      continue;
    }

    summary.open += 1;
    if (facts.priority === "high") summary.high += 1;
    summary[band] += 1;
  }

  return summary;
}

export function buildTaskBands<T>(
  items: readonly T[],
  classify: (item: T) => TaskBandKind,
): Array<TaskBand<T>> {
  const bands: Array<TaskBand<T>> = [
    { kind: "overdue", label: "Overdue", count: 0, items: [] },
    { kind: "today", label: "Today", count: 0, items: [] },
    { kind: "tomorrow", label: "Tomorrow", count: 0, items: [] },
    { kind: "high_no_due", label: "High · no due", count: 0, items: [] },
    { kind: "later", label: "Later", count: 0, items: [] },
  ];
  const byKind = new Map<TaskBandKind, TaskBand<T>>(bands.map((band) => [band.kind, band]));

  for (const item of items) {
    const band = byKind.get(classify(item));
    if (!band) continue;
    band.items.push(item);
    band.count += 1;
  }

  return bands;
}
