// Loop registry foundation slice (CTO Loops page spec, 2026-06-16, §4.3 + §5.1).
//
// A Loop is a durable, repeatable operator process (deterministic collectors +
// LLM reasoning) that produces a deliverable every run. This module is the v0
// read-model bridge the spec calls for: a STATIC seed catalog (L1-L8 from
// `agent-platform/output/loops-catalog.md`) that serves the `/ops/loops`
// read-model DTOs before the `loop_runs` runtime substrate exists. No DB, no
// execution engine yet — visible registry + placeholder health only.
//
// Everything here is pure and `now`-injected so it is deterministic + unit
// testable. When the typed substrate lands, the manager routes can swap this
// adapter for a substrate-backed one without changing the DTO contract.

export type LoopKind = "digest" | "report" | "intake" | "external_data" | "verification" | "maintenance";

export type LoopRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type LoopHealthState = "healthy" | "degraded" | "failed" | "disabled" | "unknown";

export interface LoopHealth {
  state: LoopHealthState;
  last_run_at: string | null;
  last_run_status: LoopRunStatus | null;
  last_run_phid: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  next_run_at: string | null;
  runs_last_7d: number;
  stale_after_minutes: number | null;
}

export interface LoopProjectRef {
  project_phid: string;
  name: string;
  slug: string;
}

export interface LoopLastOutput {
  artifact_phid: string | null;
  path: string | null;
  href: string | null;
  label: string | null;
}

export type ReportCadence =
  | {
      kind: "weekly";
      /** 0 = Sunday, 1 = Monday, ... */
      weekday: number;
      hour_utc: number;
      minute_utc: number;
    }
  | {
      kind: "biweekly";
      /** ISO instant for a known due occurrence; subsequent due dates repeat every 14 days. */
      anchor_due_at: string;
      hour_utc: number;
      minute_utc: number;
    }
  | {
      kind: "interval_hours";
      every_hours: number;
      anchor_due_at: string;
    };

export interface ReportDefinition {
  report_key: string;
  label: string;
  cadence: ReportCadence;
  enabled: boolean;
  grace_minutes: number;
  stale_after_minutes: number;
  artifact_required: boolean;
}

export interface LoopSummary {
  loop_phid: string;
  slug: string;
  name: string;
  description: string | null;
  kind: LoopKind;
  owner_agent: string;
  project: LoopProjectRef | null;
  enabled: boolean;
  allow_scheduled_run: boolean;
  allow_manual_run: boolean;
  schedule_label: string;
  next_run_at: string | null;
  health: LoopHealth;
  last_output: LoopLastOutput | null;
  /** Additive scheduler/report facts consumed by dashboard/API due projections. */
  report_definitions: ReportDefinition[];
  customization_summary: string | null;
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export interface LoopsListResponse {
  schema_version: "loops-list-v1";
  generated_at: string;
  source: "seed_catalog" | "substrate" | "mixed";
  loops: LoopSummary[];
  filters: {
    projects: FilterOption[];
    owners: FilterOption[];
    statuses: FilterOption[];
    kinds: FilterOption[];
  };
}

export interface DashboardLoopsSummary {
  schema_version: "loops-dashboard-summary-v1";
  generated_at: string;
  source: "seed_catalog" | "substrate" | "mixed";
  total_enabled: number;
  healthy_count: number;
  degraded_count: number;
  failed_count: number;
  next_scheduled: Array<{
    loop_phid: string;
    name: string;
    next_run_at: string;
    project_name: string | null;
  }>;
  degraded: Array<{
    loop_phid: string;
    name: string;
    health_state: LoopHealthState;
    last_run_at: string | null;
    consecutive_failures: number;
    failure_reason: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Seed catalog — L1-L8. The canonical `loop_phid` is derived deterministically
// from the reserved slug (catalog §5); slugs resolve to it on read routes. The
// substrate-backed version will mint real phids, but the slug stays stable.
// ---------------------------------------------------------------------------

interface SeedLoopDef {
  slug: string;
  name: string;
  description: string;
  kind: LoopKind;
  owner_agent: string;
  project: LoopProjectRef | null;
  /** Phase-1 catalog commitment loops are live (enabled); phase-2 loops are
   *  registered but not yet enabled. */
  enabled: boolean;
  allow_scheduled_run: boolean;
  allow_manual_run: boolean;
  schedule_label: string;
  stale_after_minutes: number | null;
  report_definitions?: ReportDefinition[];
}

const KAPELLE_PROJECT: LoopProjectRef = {
  project_phid: "phid:proj:kapelle",
  name: "Kapelle",
  slug: "kapelle",
};

const BLOWOUT_PROJECT: LoopProjectRef = {
  project_phid: "phid:proj:blowout",
  name: "Blowout",
  slug: "blowout",
};

// T-PERSONAL: the Gideon sports agent's loops live in the Personal project.
const PERSONAL_PROJECT: LoopProjectRef = {
  project_phid: "phid:proj:personal",
  name: "Personal",
  slug: "personal",
};

/** Stable canonical id for a seed loop. */
export function loopPhidForSlug(slug: string): string {
  return `phid:loop:${slug}`;
}

const SEED_LOOP_DEFS: SeedLoopDef[] = [
  {
    slug: "morning-digest",
    name: "Morning Digest",
    description:
      "Daily framing of the day in ≤8 bullets from calendar, high/due tasks, weather and news; surfaces the 1-3 highest-leverage moves.",
    kind: "digest",
    owner_agent: "maestra",
    project: null,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Daily 07:00 local (weekdays)",
    stale_after_minutes: 24 * 60,
  },
  {
    slug: "project-load",
    name: "Project Load Loop",
    description:
      "Cross-project sweep (commits, in-flight dispatches, recent artifacts, pending verifications) synthesized into an operator-readable load-up digest.",
    kind: "report",
    owner_agent: "maestra",
    project: null,
    enabled: true,
    allow_scheduled_run: false,
    allow_manual_run: true,
    schedule_label: "Manual only",
    stale_after_minutes: 18 * 60,
  },
  {
    slug: "worktree-hygiene",
    name: "Worktree Hygiene",
    description:
      "Recurring branch/worktree hygiene lane for dirty primary checkouts, unlinked branches, stale bases, branch-held worktrees and ahead/behind promotion divergence.",
    kind: "maintenance",
    owner_agent: "maestra",
    project: null,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Every 36h and on hygiene-classified promotion failures",
    stale_after_minutes: 48 * 60,
    report_definitions: [
      {
        report_key: "worktree-hygiene:guard",
        label: "Worktree Hygiene Guard",
        cadence: {
          kind: "interval_hours",
          every_hours: 36,
          anchor_due_at: "2026-07-08T15:00:00.000Z",
        },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 48 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "inbox-intake",
    name: "Inbox Intake Loop",
    description:
      "Reads inbox.md, clusters unprocessed items, and proposes per-item routes (dispatch / ack / snooze / drop) for greenlight.",
    kind: "intake",
    owner_agent: "cane",
    project: null,
    enabled: true,
    allow_scheduled_run: false,
    allow_manual_run: true,
    schedule_label: "Manual only",
    stale_after_minutes: 3 * 24 * 60,
  },
  // ── T-PERSONAL: Gideon sports agent (models the personal fantasy-sports
  // workflow Chris named). Three Personal-project loops owned by `gideon`:
  // fantasy MLB + fantasy NBA (external-data pulls) and a daily sports brief.
  // All Phase-2 (registered + manually runnable now; auto-cadence flips on once
  // the external sports-data integration lands). ──
  {
    slug: "fantasy-baseball",
    name: "Fantasy Baseball",
    description:
      "Pulls MLB matchup/injury/roster data and recommends lineup changes and waiver targets. (Phase 2 — external data integration.)",
    kind: "external_data",
    owner_agent: "gideon",
    project: PERSONAL_PROJECT,
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Daily in season (manual override)",
    stale_after_minutes: null,
  },
  {
    slug: "fantasy-basketball",
    name: "Fantasy Basketball",
    description:
      "Pulls NBA matchup/injury/roster data and recommends lineup changes and waiver targets. The basketball counterpart to fantasy-baseball. (Phase 2 — external data integration.)",
    kind: "external_data",
    owner_agent: "gideon",
    project: PERSONAL_PROJECT,
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Daily in season (manual override)",
    stale_after_minutes: null,
  },
  {
    slug: "gideon-sports-brief",
    name: "Gideon Sports Brief",
    description:
      "Daily sports brief: scores, standings and headlines for Gideon's teams plus his fantasy roster status and start/sit flags across MLB and NBA. (Phase 2 — external sports-data integration.)",
    kind: "digest",
    owner_agent: "gideon",
    project: PERSONAL_PROJECT,
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Daily 08:00 local (in season)",
    stale_after_minutes: 24 * 60,
  },
  {
    slug: "weekly-project-report",
    name: "Weekly Project Report",
    description:
      "Per-project weekly synthesis (what shipped, blockers, next week's next-3) from git, dispatch and artifact deltas. One instance per project. (Phase 2.)",
    kind: "report",
    owner_agent: "per-project-owner",
    project: null,
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Weekly Sun (per project)",
    stale_after_minutes: null,
  },
  {
    slug: "weekly-project-report-blowout",
    name: "Weekly Project Report — Blowout",
    description:
      "Blowout's weekly synthesis (headlines / what shipped / blockers / next week's next-3) from a one-week git, dispatch and artifact-mtime sweep plus decisions/risk deltas. The L5 per-project instance bound to the Blowout project.",
    kind: "report",
    owner_agent: "blowout",
    project: BLOWOUT_PROJECT,
    // Phase-2 per-project instance: registered + manually runnable now; flip
    // `enabled` to start the Sunday auto-cadence (paced to avoid Sunday throttle).
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Weekly Sun",
    stale_after_minutes: 8 * 24 * 60,
    report_definitions: [
      {
        report_key: "kapelle:weekly-project-report",
        label: "Kapelle Weekly Project Report",
        cadence: { kind: "weekly", weekday: 0, hour_utc: 15, minute_utc: 0 },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 8 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "biweekly-project-report",
    name: "Biweekly Project Report",
    description:
      "Deeper per-project biweekly synthesis (trajectory, strategy, cross-project pattern) over a longer window. One instance per project. (Phase 2.)",
    kind: "report",
    owner_agent: "per-project-owner",
    project: null,
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Biweekly (per project)",
    stale_after_minutes: null,
    report_definitions: [
      {
        report_key: "kapelle:biweekly-project-report",
        label: "Kapelle Biweekly Project Report",
        cadence: {
          kind: "biweekly",
          anchor_due_at: "2026-07-05T15:00:00.000Z",
          hour_utc: 15,
          minute_utc: 0,
        },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 16 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "maestra-product-log",
    name: "Maestra Product / Roadmap Report",
    description:
      "Weekly + biweekly Kapelle product synthesis (what shipped, what's stuck, next milestone) from dispatch, decisions, roadmap and bug-squash deltas.",
    kind: "report",
    owner_agent: "maestra",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Weekly Sun + biweekly",
    stale_after_minutes: 8 * 24 * 60,
    report_definitions: [
      {
        report_key: "kapelle:product-log-weekly",
        label: "Kapelle Product Log Weekly",
        cadence: { kind: "weekly", weekday: 0, hour_utc: 16, minute_utc: 0 },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 8 * 24 * 60,
        artifact_required: true,
      },
      {
        report_key: "kapelle:product-log-biweekly",
        label: "Kapelle Product Log Biweekly",
        cadence: {
          kind: "biweekly",
          anchor_due_at: "2026-07-05T16:00:00.000Z",
          hour_utc: 16,
          minute_utc: 0,
        },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 16 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "sentinel-verification-2h",
    name: "Sentinel Verification / Reporting",
    description:
      "2h cadence + weekly + biweekly cross-system verification: dispatch ledger sweep, artifact checks, S0/S1 ratification and anomaly flagging.",
    kind: "verification",
    owner_agent: "sentinel",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Every 2h + weekly Sun + biweekly",
    stale_after_minutes: 3 * 60,
    report_definitions: [
      {
        report_key: "kapelle:sentinel-verification-2h",
        label: "Sentinel Verification 2h",
        cadence: {
          kind: "interval_hours",
          every_hours: 2,
          anchor_due_at: "2026-07-05T00:00:00.000Z",
        },
        enabled: true,
        grace_minutes: 30,
        stale_after_minutes: 3 * 60,
        artifact_required: true,
      },
      {
        report_key: "kapelle:sentinel-weekly",
        label: "Sentinel Weekly Verification",
        cadence: { kind: "weekly", weekday: 0, hour_utc: 17, minute_utc: 0 },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 8 * 24 * 60,
        artifact_required: true,
      },
      {
        report_key: "kapelle:sentinel-biweekly",
        label: "Sentinel Biweekly Verification",
        cadence: {
          kind: "biweekly",
          anchor_due_at: "2026-07-05T17:00:00.000Z",
          hour_utc: 17,
          minute_utc: 0,
        },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 16 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "id-agents-parity-weekly",
    name: "id-agents ↔ Kapelle Parity (Weekly)",
    description:
      "Weekly id-agents↔Kapelle continuous-sync hygiene (T-DEPLOY.6): runs the id-agents-compat suite (tests/unit/id-agents-compat.test.ts) + reviews the executable parity ledger (src/compat/console-contract.ts), flagging manager/runtime API deltas before they cause a deploy-class incident. Owner Maestra.",
    kind: "verification",
    owner_agent: "maestra",
    project: KAPELLE_PROJECT,
    // Registered + manually runnable now; flip `enabled` to start the weekly cadence.
    enabled: false,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Weekly Sun",
    stale_after_minutes: 8 * 24 * 60,
  },
  {
    slug: "ux-research",
    name: "UX Research Loop",
    description:
      "First-time-user walk of the live /ops console and artifact-reader; pulls open feedback register rows, recent UI commits, and Chris UI feedback; ranks UX issues with concrete copy/layout fixes and buildable slices posted to the orchestration backlog.",
    kind: "report",
    owner_agent: "rams",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Weekly Mon 09:00 local",
    stale_after_minutes: 8 * 24 * 60,
    report_definitions: [
      {
        report_key: "kapelle:ux-research-weekly",
        label: "UX Research Weekly",
        cadence: { kind: "weekly", weekday: 1, hour_utc: 14, minute_utc: 0 },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 8 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "library-research",
    name: "Software / Library Research Loop",
    description:
      "Surveys Kapelle stack/deps, open build forks, and roadmap NOW/NEXT against changelogs; enumerates library/pattern candidates with license tag, provenance plan, and DIRECT-LIFT / pattern-reference / skip recommendation; ends in build slices posted to the backlog.",
    kind: "report",
    owner_agent: "researcher",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Biweekly Wed 09:00 local",
    stale_after_minutes: 16 * 24 * 60,
    report_definitions: [
      {
        report_key: "kapelle:library-research-biweekly",
        label: "Library Research Biweekly",
        cadence: {
          kind: "biweekly",
          anchor_due_at: "2026-07-08T14:00:00.000Z",
          hour_utc: 14,
          minute_utc: 0,
        },
        enabled: true,
        grace_minutes: 12 * 60,
        stale_after_minutes: 16 * 24 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "surface-feeder",
    name: "Surface Feeder Loop",
    description:
      "Feeds dashboard/API surfaces from recent artifacts, decisions and dispatch outcomes; reports freshness gaps and proof refs for surfaced rows.",
    kind: "report",
    owner_agent: "maestra",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Every 6h",
    stale_after_minutes: 8 * 60,
    report_definitions: [
      {
        report_key: "kapelle:surface-feeder-6h",
        label: "Surface Feeder 6h",
        cadence: {
          kind: "interval_hours",
          every_hours: 6,
          anchor_due_at: "2026-07-05T00:00:00.000Z",
        },
        enabled: true,
        grace_minutes: 90,
        stale_after_minutes: 8 * 60,
        artifact_required: true,
      },
    ],
  },
  {
    slug: "task-reconciliation",
    name: "Task Reconciliation Loop",
    description:
      "Reconciles task lifecycle facts against scheduler dispatches and artifacts, flagging stale doing rows, false done states and missing closeout proof.",
    kind: "verification",
    owner_agent: "sentinel",
    project: KAPELLE_PROJECT,
    enabled: true,
    allow_scheduled_run: true,
    allow_manual_run: true,
    schedule_label: "Every 6h",
    stale_after_minutes: 8 * 60,
    report_definitions: [
      {
        report_key: "kapelle:task-reconciliation-6h",
        label: "Task Reconciliation 6h",
        cadence: {
          kind: "interval_hours",
          every_hours: 6,
          anchor_due_at: "2026-07-05T00:00:00.000Z",
        },
        enabled: true,
        grace_minutes: 90,
        stale_after_minutes: 8 * 60,
        artifact_required: true,
      },
    ],
  },
];

/** Placeholder health for a registry-only loop (no runs recorded yet). The
 *  runtime read-model will replace this with a runs-derived rollup. */
function placeholderHealth(def: SeedLoopDef): LoopHealth {
  return {
    state: def.enabled ? "unknown" : "disabled",
    last_run_at: null,
    last_run_status: null,
    last_run_phid: null,
    last_success_at: null,
    consecutive_failures: 0,
    next_run_at: null,
    runs_last_7d: 0,
    stale_after_minutes: def.stale_after_minutes,
  };
}

function toSummary(def: SeedLoopDef): LoopSummary {
  return {
    loop_phid: loopPhidForSlug(def.slug),
    slug: def.slug,
    name: def.name,
    description: def.description,
    kind: def.kind,
    owner_agent: def.owner_agent,
    project: def.project,
    enabled: def.enabled,
    allow_scheduled_run: def.allow_scheduled_run,
    allow_manual_run: def.allow_manual_run,
    schedule_label: def.schedule_label,
    next_run_at: null, // no runtime computing next fire yet
    health: placeholderHealth(def),
    last_output: null, // no runs yet
    report_definitions: def.report_definitions ?? [],
    customization_summary: null,
  };
}

/** The full seed catalog as read-model summaries. */
export const SEED_LOOPS: readonly LoopSummary[] = SEED_LOOP_DEFS.map(toSummary);

// ---------------------------------------------------------------------------
// Read-model functions (pure; `now` injected)
// ---------------------------------------------------------------------------

export interface LoopListFilters {
  project_phid?: string | null;
  owner_agent?: string | null;
  /** Health/status state filter. */
  status?: string | null;
  kind?: string | null;
  /** Free-text search over name + slug + description. */
  q?: string | null;
}

function countBy(loops: readonly LoopSummary[], key: (l: LoopSummary) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of loops) {
    const k = key(l);
    if (k == null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function buildFilters(loops: readonly LoopSummary[]): LoopsListResponse["filters"] {
  const projects = countBy(loops, (l) => l.project?.project_phid ?? null);
  const owners = countBy(loops, (l) => l.owner_agent);
  const statuses = countBy(loops, (l) => l.health.state);
  const kinds = countBy(loops, (l) => l.kind);
  const projName = new Map<string, string>();
  for (const l of loops) if (l.project) projName.set(l.project.project_phid, l.project.name);
  const opt = (m: Map<string, number>, label?: (v: string) => string): FilterOption[] =>
    [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([value, count]) => ({ value, label: label ? label(value) : value, count }));
  return {
    projects: opt(projects, (v) => projName.get(v) ?? v),
    owners: opt(owners),
    statuses: opt(statuses),
    kinds: opt(kinds),
  };
}

/** List loops from a provided catalog, applying optional filters. Facets are
 *  computed over the full (unfiltered) catalog so the UI can offer every option.
 *  Filters (including `status`) run against each loop's CURRENT `health.state`,
 *  so passing a runs-derived catalog filters on real health, not placeholders. */
export function listLoopsFrom(
  loops: readonly LoopSummary[],
  nowIso: string,
  filters: LoopListFilters = {},
  source: LoopsListResponse["source"] = "seed_catalog",
): LoopsListResponse {
  const q = (filters.q ?? "").trim().toLowerCase();
  const filtered = loops.filter((l) => {
    if (filters.project_phid && l.project?.project_phid !== filters.project_phid) return false;
    if (filters.owner_agent && l.owner_agent !== filters.owner_agent) return false;
    if (filters.status && l.health.state !== filters.status) return false;
    if (filters.kind && l.kind !== filters.kind) return false;
    if (q) {
      const hay = `${l.name} ${l.slug} ${l.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return {
    schema_version: "loops-list-v1",
    generated_at: nowIso,
    source,
    loops: filtered,
    filters: buildFilters(loops),
  };
}

/** List loops for `/ops/loops` from the static seed catalog (placeholder
 *  health). The manager route overlays runs-derived health via
 *  `buildLoopsList` (rollup.ts) before serving. */
export function listLoops(nowIso: string, filters: LoopListFilters = {}): LoopsListResponse {
  return listLoopsFrom(SEED_LOOPS, nowIso, filters, "seed_catalog");
}

/** Resolve a loop by `loop_phid` or `slug` (read routes accept either). Returns
 *  null when not found. Display-only ids that aren't a phid/slug never match. */
export function getLoop(ref: string): LoopSummary | null {
  const r = (ref ?? "").trim();
  if (!r) return null;
  return (
    SEED_LOOPS.find((l) => l.loop_phid === r || l.slug === r) ?? null
  );
}

/** Compact dashboard summary. With registry-only health every loop is
 *  unknown/disabled, so the rollup counts are honest zeros until runs exist. */
export function loopsSummaryFrom(
  loops: readonly LoopSummary[],
  nowIso: string,
  source: DashboardLoopsSummary["source"] = "seed_catalog",
): DashboardLoopsSummary {
  const enabled = loops.filter((l) => l.enabled);
  const count = (s: LoopHealthState) => loops.filter((l) => l.health.state === s).length;
  const degraded = loops.filter(
    (l) => l.health.state === "degraded" || l.health.state === "failed",
  ).map((l) => ({
    loop_phid: l.loop_phid,
    name: l.name,
    health_state: l.health.state,
    last_run_at: l.health.last_run_at,
    consecutive_failures: l.health.consecutive_failures,
    failure_reason: null as string | null,
  }));
  const next_scheduled = loops.filter((l) => l.enabled && l.next_run_at != null)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))
    .slice(0, 3)
    .map((l) => ({
      loop_phid: l.loop_phid,
      name: l.name,
      next_run_at: l.next_run_at!,
      project_name: l.project?.name ?? null,
    }));
  return {
    schema_version: "loops-dashboard-summary-v1",
    generated_at: nowIso,
    source,
    total_enabled: enabled.length,
    healthy_count: count("healthy"),
    degraded_count: count("degraded"),
    failed_count: count("failed"),
    next_scheduled,
    degraded,
  };
}

/** Compact dashboard summary over the static seed catalog (placeholder health).
 *  The manager route overlays runs-derived health via `buildLoopsSummary`. */
export function loopsSummary(nowIso: string): DashboardLoopsSummary {
  return loopsSummaryFrom(SEED_LOOPS, nowIso, "seed_catalog");
}
