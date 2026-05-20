// `id-agents outputs <agent>` — Spec 102 §6 / Build plan step 8.
//
// One-shot CLI subcommand: fetches the agent's outputs list from the
// dashboard REST shim, optionally fetches latest-history for the
// visible rows, and either prints a terminal-readable table or emits
// the raw JSON. `--open <phid>` fetches the artifact view and prints
// the body inline.
//
// Architecture: this module owns argument parsing + URL construction.
// The fetch layer is injectable so tests can swap in a fixture
// transport without touching the network.

// Local CLI types — kept dependency-free from agent-platform packages so
// the CLI stays slim. Shape mirrors what the dashboard REST shim returns
// (defined in dashboard/app/api/_artifacts-shared/types.ts).

export interface CliArtifactSummary {
  artifact_phid: string;
  slug: string;
  title: string;
  summary: string | null;
  body_excerpt: string | null;
  kind: string;
  status: string;
  author: string;
  author_kind: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  archived_at: string | null;
  superseded_by: string | null;
}

export interface CliArtifactView extends CliArtifactSummary {
  body_markdown: string;
}

export interface CliLatestHistory {
  doc_id: string;
  op_index: number;
  op_type: string;
  actor: {
    kind: string;
    id: string;
    label: string | null;
    source: string | null;
  };
  timestamp: string;
  payload_summary: string | null;
  scope: string | null;
}

export interface OutputsArgs {
  agent: string;
  limit: number;
  page: number;
  kind: string | null;
  tag: string | null;
  since: string | null;
  json: boolean;
  open: string | null;
}

export interface OutputsDeps {
  baseUrl: string;
  fetchJson: <T>(url: string) => Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  noColor: boolean;
}

export class OutputsArgError extends Error {}

const KNOWN_FLAGS = new Set([
  "--limit",
  "--page",
  "--kind",
  "--tag",
  "--since",
  "--json",
  "--payload", // accepted for symmetry with cane ops; ignored in `outputs`
  "--open",
]);

const UTC_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

export function parseOutputsArgs(argv: string[]): OutputsArgs {
  // argv passed without the "outputs" verb (caller strips it).
  if (argv.length === 0) {
    throw new OutputsArgError("outputs <agent> [--limit N] [--page N] [--kind KIND] [--tag TAG] [--since ISO] [--json] [--open PHID]");
  }
  let agent: string | null = null;
  let limit = 25;
  let page = 1;
  let kind: string | null = null;
  let tag: string | null = null;
  let since: string | null = null;
  let json = false;
  let open: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--payload") {
      // Accepted but unused: outputs already returns summary + body via --open.
      i += 1;
      continue;
    }
    if (a.startsWith("--")) {
      if (!KNOWN_FLAGS.has(a)) {
        throw new OutputsArgError(`unknown flag: ${a}`);
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new OutputsArgError(`flag ${a} requires a value`);
      }
      if (a === "--limit") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw new OutputsArgError("--limit must be an integer 1..100");
        }
        limit = n;
      } else if (a === "--page") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) {
          throw new OutputsArgError("--page must be an integer ≥ 1");
        }
        page = n;
      } else if (a === "--kind") {
        kind = val;
      } else if (a === "--tag") {
        tag = val;
      } else if (a === "--since") {
        if (!UTC_SUFFIX_RE.test(val)) {
          throw new OutputsArgError("--since must be ISO-8601 with 'Z' or ±HH:MM offset");
        }
        since = val;
      } else if (a === "--open") {
        open = val;
      }
      i += 2;
      continue;
    }
    if (agent === null) {
      agent = a;
      i += 1;
      continue;
    }
    throw new OutputsArgError(`unexpected positional argument: ${a}`);
  }
  if (!agent) throw new OutputsArgError("outputs <agent> requires an agent name");
  return { agent, limit, page, kind, tag, since, json, open };
}

export function buildListUrl(base: string, args: OutputsArgs): string {
  const u = new URL("/api/artifacts/by-author", base);
  u.searchParams.set("author", args.agent);
  u.searchParams.set("limit", String(args.limit));
  u.searchParams.set("page", String(args.page));
  if (args.kind) u.searchParams.set("kind", args.kind);
  if (args.since) u.searchParams.set("since", args.since);
  return u.toString();
}

export function buildHistoryUrl(base: string, phids: string[]): string {
  const u = new URL("/api/artifacts/last-edited", base);
  u.searchParams.set("ids", phids.join(","));
  return u.toString();
}

export function buildViewUrl(base: string, phid: string): string {
  const u = new URL(`/api/artifacts/${encodeURIComponent(phid)}`, base);
  return u.toString();
}

const COLOR = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
};

function colorFor(actorKind: string): string {
  switch (actorKind) {
    case "agent": return COLOR.cyan;
    case "user": return COLOR.yellow;
    case "system": return COLOR.magenta;
    case "service": return COLOR.green;
    default: return COLOR.gray;
  }
}

function actorLabel(h: CliLatestHistory | undefined): string {
  if (!h) return "unknown";
  return h.actor.label || h.actor.id || "unknown";
}

function relTime(ts: string | undefined, now: Date): string {
  if (!ts) return "unknown";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "unknown";
  const delta = Math.max(0, now.getTime() - t);
  if (delta < 60_000) return "just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} hrs ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function applyTagFilter(rows: CliArtifactSummary[], tag: string | null): CliArtifactSummary[] {
  if (!tag) return rows;
  const norm = tag.trim().toLowerCase().replace(/^#/, "");
  return rows.filter((a) =>
    a.tags.some((t) => t.toLowerCase() === norm),
  );
}

export async function runOutputs(args: OutputsArgs, deps: OutputsDeps): Promise<number> {
  // --open mode: fetch the single artifact and print it.
  if (args.open) {
    const viewRes = await deps.fetchJson<{ artifact: CliArtifactView }>(buildViewUrl(deps.baseUrl, args.open));
    if (!viewRes.ok) {
      deps.stderr(`error: ${viewRes.error}\n`);
      return viewRes.status === 404 ? 2 : 1;
    }
    const histRes = await deps.fetchJson<{ history: Record<string, CliLatestHistory> }>(
      buildHistoryUrl(deps.baseUrl, [args.open]),
    );
    const hist = histRes.ok ? histRes.value.history[args.open] : undefined;
    const a = viewRes.value.artifact;
    const now = new Date();
    const lastEdited = hist
      ? `last edited ${relTime(hist.timestamp, now)} · by ${actorLabel(hist)}`
      : "last edited unknown · by unknown";
    if (args.json) {
      deps.stdout(JSON.stringify({ artifact: a, history: hist ?? null }, null, 2));
      return 0;
    }
    deps.stdout(`${COLOR.bold}${a.title}${COLOR.reset}\n`);
    deps.stdout(`${COLOR.gray}${lastEdited}${COLOR.reset}\n`);
    deps.stdout(`${COLOR.gray}kind: ${a.kind} · tags: ${a.tags.join(", ") || "(none)"} · status: ${a.status}${COLOR.reset}\n`);
    deps.stdout("\n");
    deps.stdout(`${a.body_markdown || "(no body content recorded)"}\n`);
    return 0;
  }

  // List mode.
  const listRes = await deps.fetchJson<{
    artifacts: CliArtifactSummary[];
    page: number;
    limit: number;
    total: number;
    has_next: boolean;
  }>(buildListUrl(deps.baseUrl, args));
  if (!listRes.ok) {
    deps.stderr(`error: ${listRes.error}\n`);
    return 1;
  }
  const filtered = applyTagFilter(listRes.value.artifacts, args.tag);
  let history: Record<string, CliLatestHistory> = {};
  if (filtered.length > 0) {
    const histRes = await deps.fetchJson<{ history: Record<string, CliLatestHistory> }>(
      buildHistoryUrl(deps.baseUrl, filtered.map((a) => a.artifact_phid)),
    );
    if (histRes.ok) history = histRes.value.history;
  }

  if (args.json) {
    deps.stdout(
      JSON.stringify(
        {
          artifacts: filtered,
          history,
          page: listRes.value.page,
          limit: listRes.value.limit,
          total: listRes.value.total,
          has_next: listRes.value.has_next,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  // Text mode
  const c = deps.noColor ? false : true;
  const head = c ? `${COLOR.bold}${args.agent} outputs${COLOR.reset}` : `${args.agent} outputs`;
  deps.stdout(`${head}\n\n`);
  if (filtered.length === 0) {
    deps.stdout("  (no artifacts)\n");
    return 0;
  }
  const now = new Date();
  for (const a of filtered) {
    const hist = history[a.artifact_phid];
    const kindCell = `[${a.kind}]`;
    const lastEditedColor = c ? colorFor(hist?.actor.kind ?? "unknown") : "";
    const reset = c ? COLOR.reset : "";
    const lastEditedLine = hist
      ? `last edited ${relTime(hist.timestamp, now)} · by ${lastEditedColor}${actorLabel(hist)}${reset}`
      : `last edited ${c ? COLOR.gray : ""}unknown · by unknown${reset}`;
    deps.stdout(`${lastEditedLine}\n`);
    const titleLine = c ? `${COLOR.bold}${kindCell} ${a.title}${COLOR.reset}` : `${kindCell} ${a.title}`;
    deps.stdout(`${titleLine}\n`);
    const summaryText = a.summary ?? a.body_excerpt ?? "";
    if (summaryText) deps.stdout(`${summaryText}\n`);
    deps.stdout(`${c ? COLOR.gray : ""}${a.artifact_phid}${reset}\n\n`);
  }
  if (listRes.value.has_next) {
    deps.stdout(`(more — page ${listRes.value.page + 1})\n`);
  }
  return 0;
}

/** Default fetcher backed by global fetch. */
export async function defaultFetchJson<T>(url: string): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store" } as RequestInit);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = (body as { detail?: string; error?: string }).detail ||
        (body as { error?: string }).error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error };
    }
    const value = (await res.json()) as T;
    return { ok: true, value };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Subcommand entrypoint mirroring maybeRunWorkspaceSyncCli. */
export async function maybeRunOutputsCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "outputs") return null;
  let parsed: OutputsArgs;
  try {
    parsed = parseOutputsArgs(argv.slice(1));
  } catch (e) {
    if (e instanceof OutputsArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 64; // EX_USAGE
    }
    throw e;
  }
  const baseUrl = process.env.DASHBOARD_BASE_URL || "http://localhost:3000";
  const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY;
  return runOutputs(parsed, {
    baseUrl,
    fetchJson: defaultFetchJson,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    noColor,
  });
}
