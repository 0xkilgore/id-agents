// T-DEPLOY.6 — id-agents ↔ Kapelle continuous-sync hygiene: the `id-agents-compat`
// contract substrate (the Roger piece of the track).
//
// The recurring drift class (incident I-4): the Kapelle ops console
// (`kapelle-site` /ops) reads the manager's HTTP API; when the manager renames
// or drops a route the console depends on, the console silently breaks after the
// next manager deploy. This module is the EXECUTABLE PARITY LEDGER: a grounded
// manifest of the manager routes the console consumes, plus pure helpers to
// extract the manager's actually-registered routes from source and diff them
// against the manifest. The compat test fails the build when a consumed route
// disappears — turning a deploy-time surprise into a red test pre-promote.
//
// Grounding: each manifest entry's `consumer` points at the kapelle-site ops
// adapter that calls it (verified against kapelle-site/app/ops/_lib at authoring
// time). Adding manager routes never trips the guard (additive is safe); only
// removing/renaming a consumed one does.

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** One route the Kapelle ops console depends on (the contract surface). */
export interface ConsoleContractRoute {
  method: HttpMethod;
  /** Route path as registered in the manager (Express style, `:param`). */
  path: string;
  /** The kapelle-site ops adapter that consumes it (provenance). */
  consumer: string;
  note?: string;
}

/** A route signature extracted from manager source. */
export interface RouteSig {
  method: HttpMethod;
  path: string;
}

/**
 * The manager routes the Kapelle ops console (`kapelle-site` /ops) consumes.
 * This is the parity ledger in code form — keep it in sync with the console's
 * `app/ops/_lib/*Adapter.ts` calls. A removed/renamed manager route here is the
 * drift signal the compat test catches.
 */
export const CONSOLE_CONTRACT_ROUTES: ConsoleContractRoute[] = [
  { method: "get", path: "/health", consumer: "summaryAdapter / consoleHealth (manager health + fleet_freshness)" },
  { method: "get", path: "/agents", consumer: "agentHealthAdapter (fleet roster + health)" },
  { method: "get", path: "/agents/:name/detail", consumer: "agent detail dossier (agent-page-v2)" },
  { method: "get", path: "/tasks", consumer: "taskAdapter (/tasks?team=default)" },
  { method: "get", path: "/usage", consumer: "usageAdapter (tokens/cost panel)" },
  { method: "get", path: "/dispatches", consumer: "provenanceAdapter (dispatch pipeline)" },
  { method: "get", path: "/dispatches/health", consumer: "provenanceAdapter (dispatch health)" },
  { method: "get", path: "/artifacts", consumer: "artifactAdapter / provenanceAdapter (artifact lane)" },
  { method: "get", path: "/inbox/items", consumer: "inboxAdapter (inbox lane)" },
  { method: "get", path: "/inbox/summary", consumer: "inboxAdapter (inbox summary)" },
];

/**
 * Manager source files that register HTTP routes the console may consume.
 * Relative to the repo root. Scanned by the compat test.
 */
export const MANAGER_ROUTE_SOURCE_FILES: string[] = [
  "src/agent-manager-db.ts",
  "src/usage-meter/routes.ts",
  "src/inbox/routes.ts",
  "src/outputs/routes.ts",
  "src/graph/routes.ts",
];

// Matches an Express-style route registration on any router/app object, e.g.
//   this.managementApp.get('/agents', ...)
//   app.post("/tasks", ...)
//   router.patch(`/agents/:name/catalog`, ...)
const ROUTE_RE = /\.(get|post|put|patch|delete)\(\s*[`'"](\/[^`'"]*)[`'"]/g;

/**
 * Extract every registered route signature from a manager source file's text.
 * Pure. Catches any `<obj>.<method>('<path>'` registration where the path is a
 * string literal beginning with `/`.
 */
export function extractRegisteredRoutes(sourceText: string): RouteSig[] {
  const out: RouteSig[] = [];
  for (const m of sourceText.matchAll(ROUTE_RE)) {
    out.push({ method: m[1] as HttpMethod, path: m[2] });
  }
  return out;
}

/**
 * Normalize a route path for comparison: collapse each `:param` segment to a
 * placeholder so a contract `/agents/:name/detail` matches a registration that
 * named the param differently (`/agents/:agent/detail`). Trailing slash trimmed
 * (except the root). Query strings are not expected here but are stripped
 * defensively. Pure.
 */
export function normalizeRoutePath(path: string): string {
  const noQuery = path.split("?")[0];
  const collapsed = noQuery.replace(/:[^/]+/g, ":x");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

function sigKey(method: HttpMethod, path: string): string {
  return `${method} ${normalizeRoutePath(path)}`;
}

/**
 * Diff the manifest against the registered routes: return the contract routes
 * that are NO LONGER registered (the drift the compat guard fails on). Pure.
 */
export function findMissingContractRoutes(
  registered: RouteSig[],
  contract: ConsoleContractRoute[] = CONSOLE_CONTRACT_ROUTES,
): ConsoleContractRoute[] {
  const have = new Set(registered.map((r) => sigKey(r.method, r.path)));
  return contract.filter((c) => !have.has(sigKey(c.method, c.path)));
}
