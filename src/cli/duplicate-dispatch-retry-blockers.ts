// `id-agents duplicate-dispatch-retry-blockers` — read-only dry-run report for
// READY backlog rows held by duplicate_dispatch_retry_required.

export interface DuplicateDispatchRetryBlockersArgs {
  managerUrl: string;
  json: boolean;
}

export class DuplicateDispatchRetryBlockersArgError extends Error {}

export function parseDuplicateDispatchRetryBlockersArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DuplicateDispatchRetryBlockersArgs {
  let managerUrl = env.MANAGER_URL || "http://127.0.0.1:4100";
  let json = false;
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
        throw new DuplicateDispatchRetryBlockersArgError("--manager-url requires a value");
      }
      managerUrl = val;
      i += 2;
      continue;
    }
    throw new DuplicateDispatchRetryBlockersArgError(`unknown argument: ${arg}`);
  }
  return { managerUrl, json };
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
    stderr("Usage: id-agents duplicate-dispatch-retry-blockers [--manager-url URL] [--json]\n");
    return 2;
  }

  const url = new URL("/orchestration/backlog/duplicate-dispatch-retry-blockers", args.managerUrl);
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
