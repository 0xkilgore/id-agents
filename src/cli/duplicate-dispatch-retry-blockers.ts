// `id-agents duplicate-dispatch-retry-blockers` — read-only dry-run report for
// READY backlog rows held by duplicate_dispatch_retry_required.

export interface DuplicateDispatchRetryBlockersArgs {
  managerUrl: string;
  json: boolean;
  staleClarifications: boolean;
  olderThanHours: number;
  limit: number;
}

export class DuplicateDispatchRetryBlockersArgError extends Error {}

export function parseDuplicateDispatchRetryBlockersArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DuplicateDispatchRetryBlockersArgs {
  let managerUrl = env.MANAGER_URL || "http://127.0.0.1:4100";
  let json = false;
  let staleClarifications = false;
  let olderThanHours = 24;
  let limit = 25;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (arg === "--stale-clarifications") {
      staleClarifications = true;
      i += 1;
      continue;
    }
    if (arg === "--older-than-hours" || arg === "--limit") {
      const val = Number(argv[i + 1]);
      if (!Number.isFinite(val) || val < 1 || (arg === "--limit" && val > 100)) {
        throw new DuplicateDispatchRetryBlockersArgError(`${arg} requires a positive number${arg === "--limit" ? " no greater than 100" : ""}`);
      }
      if (arg === "--older-than-hours") olderThanHours = val;
      else limit = Math.floor(val);
      i += 2;
      continue;
    }
    if (arg === "--manager-url") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        throw new DuplicateDispatchRetryBlockersArgError("--manager-url requires a value");
      }
      managerUrl = val;
      i += 2;
      continue;
    }
    throw new DuplicateDispatchRetryBlockersArgError(`unknown argument: ${arg}`);
  }
  return { managerUrl, json, staleClarifications, olderThanHours, limit };
}

export async function runDuplicateDispatchRetryBlockersCli(
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
  let args: DuplicateDispatchRetryBlockersArgs;
  try {
    args = parseDuplicateDispatchRetryBlockersArgs(argv, deps.env ?? process.env);
  } catch (err) {
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    stderr("Usage: id-agents duplicate-dispatch-retry-blockers [--manager-url URL] [--json] [--stale-clarifications] [--older-than-hours N] [--limit N]\n");
    return 2;
  }

  const path = args.staleClarifications
    ? "/orchestration/backlog/duplicate-dispatch-retry-blockers/stale-clarifications"
    : "/orchestration/backlog/duplicate-dispatch-retry-blockers";
  const url = new URL(path, args.managerUrl);
  if (args.staleClarifications) {
    url.searchParams.set("older_than_hours", String(args.olderThanHours));
    url.searchParams.set("limit", String(args.limit));
  }
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
    stderr(`duplicate-dispatch-retry-blockers failed (${response.status}): ${body.error ?? text}\n`);
    return 1;
  }

  if (args.json) {
    stdout(`${JSON.stringify(body.report, null, 2)}\n`);
    return 0;
  }

  const report = body.report;
  if (args.staleClarifications) {
    stdout(`stale needs-clarification duplicate retry blockers: ${report.count} (matched ${report.matched}, older than ${report.older_than_hours}h, dry-run)\n`);
    stdout(`${report.guidance}\n`);
    for (const item of report.items ?? []) {
      stdout(`- ${item.item_id} prior=${item.prior_dispatch_id} age=${item.prior_dispatch_age_hours}h action=${item.operator_action} retry_safe=leave_false\n`);
    }
    return 0;
  }
  stdout(`duplicate dispatch retry blockers: ${report.count} (scanned ${report.scanned}, dry-run)\n`);
  for (const item of report.items ?? []) {
    stdout(
      `- ${item.item_id} owner=${item.owner ?? "unassigned"} prior=${item.prior_dispatch_id} ` +
        `status=${item.prior_dispatch_status ?? "unknown"} retry_safe=${item.retry_safe_recommendation ?? "unknown"} ` +
        `disposition=${item.operator_disposition ?? item.recommended_disposition}: ${item.reason}\n`,
    );
  }
  return 0;
}

export async function maybeRunDuplicateDispatchRetryBlockersCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== "duplicate-dispatch-retry-blockers") return null;
  return runDuplicateDispatchRetryBlockersCli(argv.slice(1));
}
