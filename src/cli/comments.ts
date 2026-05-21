// `id-agents comments <agent>` — Spec 102 Phase-D §3 / Build plan step 8.
//
// One-shot CLI for agents to poll unread Artifact comments authored by
// Chris (or any human/manager comment producer) without opening the
// dashboard. Mirrors src/cli/outputs.ts in shape so the CLI surfaces stay
// uniform — args parsing, deps-injected fetch, optional `--json`.

export interface CliArtifactCommentActor {
  type?: string;
  kind?: string;
  id: string;
  displayName?: string | null;
  label?: string | null;
  source?: string | null;
}

export interface CliArtifactCommentSummary {
  artifact_phid: string;
  slug: string;
  title: string;
  author_agent_id: string;
  comment_id: string;
  comment_op_id: string;
  actor: CliArtifactCommentActor;
  body_excerpt: string;
  anchor_json: string | null;
  created_at: string;
  read_by_author_at: string | null;
  addressed_at: string | null;
}

export interface CommentsArgs {
  agent: string;
  limit: number;
  json: boolean;
  ack: { artifactPhid: string; commentId: string } | null;
}

export interface CommentsDeps {
  baseUrl: string;
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<
    | { ok: true; value: T }
    | { ok: false; status: number; error: string }
  >;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  noColor: boolean;
}

export class CommentsArgError extends Error {}

const KNOWN_FLAGS = new Set(["--limit", "--json", "--ack"]);

export function parseCommentsArgs(argv: string[]): CommentsArgs {
  if (argv.length === 0) {
    throw new CommentsArgError(
      "comments <agent> [--limit N] [--json] [--ack <artifact-phid> <comment-id>]",
    );
  }
  let agent: string | null = null;
  let limit = 100;
  let json = false;
  let ack: CommentsArgs["ack"] = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--ack") {
      const phid = argv[i + 1];
      const cid = argv[i + 2];
      if (!phid || phid.startsWith("--") || !cid || cid.startsWith("--")) {
        throw new CommentsArgError(
          "--ack requires <artifact-phid> <comment-id>",
        );
      }
      ack = { artifactPhid: phid, commentId: cid };
      i += 3;
      continue;
    }
    if (a.startsWith("--")) {
      if (!KNOWN_FLAGS.has(a)) {
        throw new CommentsArgError(`unknown flag: ${a}`);
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new CommentsArgError(`flag ${a} requires a value`);
      }
      if (a === "--limit") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw new CommentsArgError("--limit must be an integer 1..100");
        }
        limit = n;
      }
      i += 2;
      continue;
    }
    if (agent === null) {
      agent = a;
      i += 1;
      continue;
    }
    throw new CommentsArgError(`unexpected positional argument: ${a}`);
  }
  if (!agent) throw new CommentsArgError("comments <agent> requires an agent name");
  return { agent, limit, json, ack };
}

export function buildUnreadUrl(base: string, args: CommentsArgs): string {
  const u = new URL(
    `/api/agents/${encodeURIComponent(args.agent)}/artifact-comments/unread`,
    base,
  );
  u.searchParams.set("limit", String(args.limit));
  return u.toString();
}

export function buildAckUrl(
  base: string,
  artifactPhid: string,
  commentId: string,
): string {
  return new URL(
    `/api/artifacts/${encodeURIComponent(artifactPhid)}/comments/${encodeURIComponent(commentId)}/ack`,
    base,
  ).toString();
}

const COLOR = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function relTime(ts: string | undefined | null, now: Date): string {
  if (!ts) return "unknown";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "unknown";
  const delta = Math.max(0, now.getTime() - t);
  if (delta < 60_000) return "just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} hrs ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function actorDisplay(actor: CliArtifactCommentActor | null | undefined): string {
  if (!actor) return "unknown";
  return (
    actor.displayName?.trim() ||
    actor.label?.trim() ||
    actor.id?.trim() ||
    "unknown"
  );
}

export async function runComments(
  args: CommentsArgs,
  deps: CommentsDeps,
): Promise<number> {
  if (args.ack) {
    const res = await deps.fetchJson<{ comment: { comment_id: string } }>(
      buildAckUrl(deps.baseUrl, args.ack.artifactPhid, args.ack.commentId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: args.agent }),
      } as RequestInit,
    );
    if (!res.ok) {
      deps.stderr(`error: ${res.error}\n`);
      return 1;
    }
    if (args.json) {
      deps.stdout(JSON.stringify({ acked: res.value.comment }, null, 2) + "\n");
    } else {
      deps.stdout(`acked ${res.value.comment.comment_id}\n`);
    }
    return 0;
  }

  const res = await deps.fetchJson<{ comments: CliArtifactCommentSummary[] }>(
    buildUnreadUrl(deps.baseUrl, args),
  );
  if (!res.ok) {
    deps.stderr(`error: ${res.error}\n`);
    return 1;
  }
  const comments = res.value.comments ?? [];
  if (args.json) {
    deps.stdout(JSON.stringify({ comments }, null, 2) + "\n");
    return 0;
  }
  if (comments.length === 0) {
    deps.stdout("(no unread artifact comments)\n");
    return 0;
  }
  const c = !deps.noColor;
  const now = new Date();
  for (const cm of comments) {
    const title = c ? `${COLOR.bold}${cm.title}${COLOR.reset}` : cm.title;
    const phid = c ? `${COLOR.gray}${cm.artifact_phid}${COLOR.reset}` : cm.artifact_phid;
    const cid = c ? `${COLOR.gray}${cm.comment_id}${COLOR.reset}` : cm.comment_id;
    const author = c
      ? `${COLOR.cyan}${actorDisplay(cm.actor)}${COLOR.reset}`
      : actorDisplay(cm.actor);
    deps.stdout(`${title}  ${phid}\n`);
    deps.stdout(`  ${author} · ${relTime(cm.created_at, now)} · ${cid}\n`);
    if (cm.body_excerpt) deps.stdout(`  ${cm.body_excerpt}\n`);
    deps.stdout("\n");
  }
  return 0;
}

/** Default fetcher backed by global fetch. */
export async function defaultFetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...(init ?? {}) } as RequestInit);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error =
        (body as { detail?: string; error?: string }).detail ||
        (body as { error?: string }).error ||
        `HTTP ${res.status}`;
      return { ok: false, status: res.status, error };
    }
    const value = (await res.json()) as T;
    return { ok: true, value };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Subcommand entrypoint mirroring maybeRunOutputsCli. */
export async function maybeRunCommentsCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "comments") return null;
  let parsed: CommentsArgs;
  try {
    parsed = parseCommentsArgs(argv.slice(1));
  } catch (e) {
    if (e instanceof CommentsArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 64; // EX_USAGE
    }
    throw e;
  }
  const baseUrl = process.env.DASHBOARD_BASE_URL || "http://localhost:3000";
  const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY;
  return runComments(parsed, {
    baseUrl,
    fetchJson: defaultFetchJson,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    noColor,
  });
}

// ────────────────────────────────────────────────────────────────────
// SDK helper for agents that want unread comments without spawning the
// CLI. Defaults agentId to process.env.AGENT_NAME so an agent runtime
// can call it as a one-liner.
// ────────────────────────────────────────────────────────────────────

export interface PollUnreadOptions {
  limit?: number;
  dashboardBaseUrl?: string;
  agentId?: string;
}

export async function pollUnreadArtifactCommentsForSelf(
  options: PollUnreadOptions = {},
): Promise<CliArtifactCommentSummary[]> {
  const agentId = options.agentId || process.env.AGENT_NAME;
  if (!agentId) {
    throw new Error(
      "pollUnreadArtifactCommentsForSelf: agentId required (pass options.agentId or set AGENT_NAME)",
    );
  }
  const baseUrl =
    options.dashboardBaseUrl ||
    process.env.DASHBOARD_BASE_URL ||
    "http://localhost:3000";
  const limit = Math.max(1, Math.min(100, options.limit ?? 100));
  const url = buildUnreadUrl(baseUrl, { agent: agentId, limit, json: true, ack: null });
  const res = await defaultFetchJson<{ comments: CliArtifactCommentSummary[] }>(url);
  if (!res.ok) {
    throw new Error(
      `pollUnreadArtifactCommentsForSelf: ${res.error} (status ${res.status})`,
    );
  }
  return res.value.comments ?? [];
}
