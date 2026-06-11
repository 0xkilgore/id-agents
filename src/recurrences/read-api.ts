// Read API for the RecurrenceTemplate substrate.
//
// DTOs mirror the OP-1 decisions queue contract shape so the
// Kapelle widget can render Today/This Week panels without
// re-deriving freshness/provenance per-substrate.
//
// CTO scope §"Query/API Surface".

import type { DbAdapter } from "../db/db-adapter.js";
import {
  listExceptions,
  listInstancesInWindow,
  listInstancesForTemplate,
  listTemplates,
  getTemplate as getTemplateRow,
  type ListTemplatesFilter,
} from "./storage.js";
import {
  type FetchTemplateResponse,
  type ListActiveTemplatesResponse,
  type ListInstancesResponse,
  type RecurrenceInstanceStatus,
  type RecurrenceTemplateKind,
} from "./types.js";

const SCHEMA_TEMPLATES = "recurrences.templates.v1" as const;
const SCHEMA_INSTANCES = "recurrences.instances.v1" as const;
const SCHEMA_TEMPLATE_DETAIL = "recurrences.template_detail.v1" as const;

const EMPTY_INSTANCE_COUNTS: Record<RecurrenceInstanceStatus, number> = {
  planned: 0,
  materialized: 0,
  dispatched: 0,
  completed: 0,
  skipped: 0,
  cancelled: 0,
  failed: 0,
};

export interface ListActiveTemplatesArgs {
  kind?: RecurrenceTemplateKind;
  owner_agent?: string;
  project_phid?: string;
  window_days?: number;
}

export async function listActiveTemplatesResponse(
  adapter: DbAdapter,
  args: ListActiveTemplatesArgs,
  now: string,
): Promise<ListActiveTemplatesResponse> {
  const filter: ListTemplatesFilter = {
    kind: args.kind,
    owner_agent: args.owner_agent,
    project_phid: args.project_phid,
  };
  const all = await listTemplates(adapter, filter);
  const counts = {
    active: all.filter((t) => t.status === "active").length,
    paused: all.filter((t) => t.status === "paused").length,
  };
  const warnings: string[] = [];
  if (args.window_days && args.window_days <= 0) {
    warnings.push("window_days <= 0 is ignored");
  }
  return {
    schema_version: SCHEMA_TEMPLATES,
    generated_at: now,
    source: "manager_recurrence_table",
    freshness: "fresh",
    provenance: {
      generated_by: "recurrences.read_api.v1",
      query_args: args as unknown as Record<string, unknown>,
    },
    filters: {
      kind: args.kind,
      owner_agent: args.owner_agent,
      project_phid: args.project_phid,
      window_days: args.window_days,
    },
    counts,
    templates: all,
    warnings,
  };
}

export type InstancesWindow = "today" | "this_week" | "custom";

export interface ListInstancesArgs {
  window: InstancesWindow;
  starts_at?: string;
  ends_at?: string;
  timezone?: string;
}

export async function listInstancesResponse(
  adapter: DbAdapter,
  args: ListInstancesArgs,
  now: string,
): Promise<ListInstancesResponse> {
  const range = resolveWindow(args, now);
  const rows = await listInstancesInWindow(adapter, range.start, range.end);
  const counts = { ...EMPTY_INSTANCE_COUNTS };
  for (const r of rows) counts[r.status] += 1;
  return {
    schema_version: SCHEMA_INSTANCES,
    generated_at: now,
    source: "manager_recurrence_table",
    freshness: "fresh",
    provenance: {
      generated_by: "recurrences.read_api.v1",
      query_args: args as unknown as Record<string, unknown>,
    },
    filters: {
      window: args.window,
      starts_at: range.start,
      ends_at: range.end,
    },
    counts,
    instances: rows,
    warnings: [],
  };
}

export async function fetchTemplateResponse(
  adapter: DbAdapter,
  recurrencePhid: string,
  now: string,
  recentInstancesLimit = 25,
): Promise<FetchTemplateResponse | null> {
  const template = await getTemplateRow(adapter, recurrencePhid);
  if (!template) return null;
  const instances = await listInstancesForTemplate(
    adapter,
    recurrencePhid,
    recentInstancesLimit,
  );
  const exceptions = await listExceptions(adapter, recurrencePhid);
  return {
    schema_version: SCHEMA_TEMPLATE_DETAIL,
    generated_at: now,
    source: "manager_recurrence_table",
    freshness: "fresh",
    provenance: {
      generated_by: "recurrences.read_api.v1",
      query_args: { recurrence_phid: recurrencePhid },
    },
    template,
    recent_instances: instances,
    exceptions,
  };
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

function resolveWindow(
  args: ListInstancesArgs,
  now: string,
): { start: string; end: string } {
  if (args.window === "custom") {
    if (!args.starts_at || !args.ends_at) {
      throw new Error("custom window requires starts_at + ends_at");
    }
    return { start: args.starts_at, end: args.ends_at };
  }
  const nowMs = Date.parse(now);
  if (args.window === "today") {
    const start = startOfDayInTzMillis(nowMs, args.timezone ?? "UTC");
    const end = start + 24 * 60 * 60 * 1000;
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }
  // this_week — 7 days starting from start-of-today.
  const start = startOfDayInTzMillis(nowMs, args.timezone ?? "UTC");
  const end = start + 7 * 24 * 60 * 60 * 1000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function startOfDayInTzMillis(utcMillis: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(new Date(utcMillis));
  const [y, m, d] = ymd.split("-").map(Number);
  // Construct midnight UTC for that local date and let Date.parse handle
  // it. For non-UTC timezones the caller's "today" boundary is naturally
  // the local-date boundary, which is what operators expect.
  return Date.UTC(y, m - 1, d);
}
