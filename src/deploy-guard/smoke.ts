// T-DEPLOY.5 (2026-06-22) — post-deploy smoke health-check.
//
// After a kickstart, prove the new build is actually serving: the process
// restarted (pid changed), the running build == origin/main (behind_origin
// false), and the key routes answer 200. The evaluator is pure; runSmokeProbe
// does the HTTP I/O. A failing smoke is what triggers auto-rollback.

export interface RouteProbe {
  path: string;
  status: number | null;
}

export interface SmokeProbe {
  /** pid before kickstart (captured by the deploy flow), null if unknown. */
  pid_before: number | null;
  /** pid after kickstart, null if the manager isn't listening. */
  pid_after: number | null;
  build_sha: string | null;
  origin_main_sha: string | null;
  behind_origin: boolean | null;
  routes: RouteProbe[];
}

export interface SmokeCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SmokeResult {
  pass: boolean;
  checks: SmokeCheck[];
  failures: string[];
  build_sha: string | null;
}

/** Pure: evaluate a probe against the post-deploy acceptance criteria. */
export function evaluateSmoke(probe: SmokeProbe): SmokeResult {
  const checks: SmokeCheck[] = [];

  // 1. The process actually restarted.
  const pidChanged = probe.pid_after != null && probe.pid_after !== probe.pid_before;
  checks.push({
    name: "pid_changed",
    pass: pidChanged,
    detail: `before=${probe.pid_before ?? "?"} after=${probe.pid_after ?? "down"}`,
  });

  // 2. The running build is the freshly-promoted origin/main.
  const buildMatchesOrigin =
    probe.build_sha != null && probe.origin_main_sha != null && probe.build_sha === probe.origin_main_sha;
  checks.push({
    name: "build_sha_matches_origin",
    pass: buildMatchesOrigin,
    detail: `build=${shortSha(probe.build_sha)} origin=${shortSha(probe.origin_main_sha)}`,
  });

  // 3. Not behind origin.
  checks.push({
    name: "not_behind_origin",
    pass: probe.behind_origin === false,
    detail: `behind_origin=${probe.behind_origin}`,
  });

  // 4. Every key route answers 200.
  for (const r of probe.routes) {
    checks.push({
      name: `route ${r.path}`,
      pass: r.status === 200,
      detail: `status=${r.status ?? "no-response"}`,
    });
  }

  const failures = checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`);
  return { pass: failures.length === 0, checks, failures, build_sha: probe.build_sha };
}

export interface RunSmokeOptions {
  baseUrl: string;
  pidBefore: number | null;
  pidAfter: number | null;
  /** Key routes to probe for a 200. Defaults to a minimal core set. */
  routes?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SMOKE_ROUTES = ["/health", "/loops", "/outputs/inbox"];

/** Probe a running manager and evaluate the smoke. Thin I/O around evaluateSmoke. */
export async function runSmokeProbe(opts: RunSmokeOptions): Promise<SmokeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const routePaths = opts.routes ?? DEFAULT_SMOKE_ROUTES;
  const base = opts.baseUrl.replace(/\/+$/, "");

  const probeRoute = async (path: string): Promise<RouteProbe> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await doFetch(`${base}${path}`, { signal: ctrl.signal });
      clearTimeout(t);
      return { path, status: res.status };
    } catch {
      return { path, status: null };
    }
  };

  const routes = await Promise.all(routePaths.map(probeRoute));

  // Pull build identity from /health.build.
  let build_sha: string | null = null;
  let origin_main_sha: string | null = null;
  let behind_origin: boolean | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await doFetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const body = (await res.json()) as { build?: { build_sha?: string; origin_main_sha?: string; behind_origin?: boolean | null } };
    build_sha = body.build?.build_sha ?? null;
    origin_main_sha = body.build?.origin_main_sha ?? null;
    behind_origin = body.build?.behind_origin ?? null;
  } catch {
    /* leave nulls — the checks will fail appropriately */
  }

  return evaluateSmoke({
    pid_before: opts.pidBefore,
    pid_after: opts.pidAfter,
    build_sha,
    origin_main_sha,
    behind_origin,
    routes,
  });
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}
