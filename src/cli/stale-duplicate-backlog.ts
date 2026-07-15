// `id-agents stale-duplicate-backlog` — read-only operator report for
// already-dispatched orchestration backlog rows whose prior dispatch is
// terminal. Mutates nothing; the API response includes compare-and-set style
// closeout payloads for an explicit follow-up tool.

export interface StaleDuplicateBacklogArgs {
  managerUrl: string;
  json: boolean;
  limit?: number;
}

export class StaleDuplicateBacklogArgError extends Error {}

export function parseStaleDuplicateBacklogArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): StaleDuplicateBacklogArgs {
  let managerUrl = env.MANAGER_URL || "http://127.0.0.1:4100";
  let json = false;
  let limit: number | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (arg === "--manager-url") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        throw new StaleDuplicateBacklogArgError("--manager-url requires a value");
      }
      managerUrl = val;
      i += 2;
      continue;
    }
    if (arg === "--limit") {
      const val = argv[i + 1];
      const parsed = Number(val);
      if (!val || val.startsWith("--") || !Number.isFinite(parsed) || parsed <= 0) {
        throw new StaleDuplicateBacklogArgError("--limit requires a positive number");
      }
      limit = Math.floor(parsed);
      i += 2;
      continue;
    }
    throw new StaleDuplicateBacklogArgError(`unknown argument: ${arg}`);
  }
  return { managerUrl, json, limit };
}

export async function runStaleDuplicateBacklogCli(
  argv: string[],
  deps: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  let args: StaleDuplicateBacklogArgs;
  try {
    args = parseStaleDuplicateBacklogArgs(argv, deps.env ?? process.env);
  } catch (err) {
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    stderr("Usage: id-agents stale-duplicate-backlog [--manager-url URL] [--limit N] [--json]\n");
    return 2;
  }

  const url = new URL("/orchestration/backlog/stale-duplicates", args.managerUrl);
  if (args.limit !== undefined) url.searchParams.set("limit", String(args.limit));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: text };
  }

  if (!response.ok || !body.ok) {
    stderr(`stale-duplicate-backlog failed (${response.status}): ${body.error ?? text}\n`);
    return 1;
  }

  if (args.json) {
    stdout(`${JSON.stringify(body.report, null, 2)}\n`);
    return 0;
  }

  const report = body.report;
  const suffix = report.truncated ? `, ${report.matched - report.count} more matched` : "";
  stdout(`stale duplicate backlog rows: ${report.count} (matched ${report.matched}, scanned ${report.scanned}, dry-run${suffix})\n`);
  for (const item of report.items ?? []) {
    stdout(
      `- ${item.item_id} [${item.readiness_state}] prior=${item.prior_dispatch_phid} ` +
        `status=${item.prior_terminal_status} action=${item.recommended_action}\n`,
    );
  }
  return 0;
}

export async function maybeRunStaleDuplicateBacklogCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "stale-duplicate-backlog") return null;
  return runStaleDuplicateBacklogCli(argv.slice(1));
}
