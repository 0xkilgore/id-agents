// SPDX-License-Identifier: MIT
/**
 * Public-team CLI commands — pure module (no readline, no process.exit).
 *
 * Exports:
 *   addPublicAgent    — validate well-known, POST /agents/register
 *   listPublicAgents  — GET /agents?team=public
 *   removePublicAgent — resolve by name or domain, DELETE /agents/:id
 *
 * Callers supply { managerBaseUrl, fetch } so this module is trivially
 * testable against a real in-process manager without spawning a subprocess.
 */

export interface PublicCommandDeps {
  /** e.g. "http://127.0.0.1:4100" */
  managerBaseUrl: string;
  /** window.fetch / node-fetch compatible */
  fetch: typeof globalThis.fetch;
}

export interface AddPublicAgentOpts {
  sshTarget?: string | null;
  internalPort?: number | null;
}

export interface PublicCommandResult {
  ok: true;
  message: string;
  data?: any;
}

export interface PublicCommandError {
  ok: false;
  error: string;
}

export type PublicCommandOutcome = PublicCommandResult | PublicCommandError;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Strip protocol and trailing slash from whatever the user typed. */
function normalizeDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Derive a valid kebab-case agent name from a domain.
 * e.g. "docs.customer.com" → "docs-customer-com"
 */
function domainToName(domain: string): string {
  return domain
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Public-team admin headers */
function publicHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': 'public',
    'X-Id-Admin': '1',
    ...extra,
  };
}

// ─── addPublicAgent ──────────────────────────────────────────────────────────

export async function addPublicAgent(
  rawDomain: string,
  opts: AddPublicAgentOpts,
  deps: PublicCommandDeps,
): Promise<PublicCommandOutcome> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return { ok: false, error: 'Domain is required. Usage: /public add <domain>' };
  }

  // Step 1: fetch well-known
  const wellKnownUrl = `https://${domain}/.well-known/restap.json`;
  let wk: any;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let resp: Response;
    try {
      resp = await deps.fetch(wellKnownUrl, { signal: controller.signal as any }) as any;
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      return {
        ok: false,
        error: `Well-known fetch failed: HTTP ${resp.status} from ${wellKnownUrl}`,
      };
    }
    try {
      wk = await resp.json();
    } catch {
      return {
        ok: false,
        error: `Well-known response from ${wellKnownUrl} is not valid JSON`,
      };
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: `Well-known fetch timed out after 5s: ${wellKnownUrl}` };
    }
    return { ok: false, error: `Network error fetching ${wellKnownUrl}: ${err?.message ?? String(err)}` };
  }

  // Step 2: validate required fields
  if (wk.service_type !== 'public-agent') {
    return {
      ok: false,
      error: `Invalid well-known: service_type must be "public-agent" (got: ${JSON.stringify(wk.service_type)})`,
    };
  }
  if (!wk.version || typeof wk.version !== 'string') {
    return { ok: false, error: 'Invalid well-known: missing or empty "version" field' };
  }
  if (!wk.endpoints?.talk || typeof wk.endpoints.talk !== 'string') {
    return { ok: false, error: 'Invalid well-known: missing or empty "endpoints.talk" field' };
  }
  if (!wk.public_url || typeof wk.public_url !== 'string') {
    return { ok: false, error: 'Invalid well-known: missing "public_url" field' };
  }

  // Step 3: verify public_url host matches the domain we fetched
  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(wk.public_url);
  } catch {
    return { ok: false, error: `Invalid well-known: public_url is not a valid URL (got: ${wk.public_url})` };
  }
  if (parsedPublicUrl.hostname.toLowerCase() !== domain) {
    return {
      ok: false,
      error: `Invalid well-known: public_url host "${parsedPublicUrl.hostname}" does not match domain "${domain}"`,
    };
  }

  // Step 4: derive name
  const agentName: string = (wk.name && typeof wk.name === 'string' && wk.name.trim())
    ? domainToName(wk.name.trim())
    : domainToName(domain);

  // Step 5: build register payload
  const body: Record<string, any> = {
    name: agentName,
    runtime: 'public-agent-remote',
    customer_domain: domain,
    public_endpoint_url: `https://${domain}`,
  };
  if (opts.sshTarget) body.ssh_target = opts.sshTarget;
  if (opts.internalPort) body.internal_endpoint_url = `http://127.0.0.1:${opts.internalPort}`;

  // Step 6: POST to manager
  let regResp: Response;
  try {
    regResp = await deps.fetch(`${deps.managerBaseUrl}/agents/register`, {
      method: 'POST',
      headers: publicHeaders(),
      body: JSON.stringify(body),
    }) as any;
  } catch (err: any) {
    return { ok: false, error: `Manager unreachable: ${err?.message ?? String(err)}` };
  }

  if (!regResp.ok) {
    let errMsg = `Registration failed: HTTP ${regResp.status}`;
    try {
      const errBody: any = await regResp.json();
      errMsg = errBody.message || errBody.error || errMsg;
    } catch { /* use default */ }
    return { ok: false, error: errMsg };
  }

  const regData: any = await regResp.json();
  return {
    ok: true,
    message: `Registered ${domain} as public-agent/${agentName}`,
    data: regData,
  };
}

// ─── listPublicAgents ────────────────────────────────────────────────────────

export interface PublicAgentEntry {
  id: string;
  name: string;
  customer_domain: string | null;
  status: string;
  public_endpoint_url: string | null;
}

export async function listPublicAgents(
  deps: PublicCommandDeps,
): Promise<{ ok: true; agents: PublicAgentEntry[] } | PublicCommandError> {
  let resp: Response;
  try {
    resp = await deps.fetch(`${deps.managerBaseUrl}/agents`, {
      headers: publicHeaders(),
    }) as any;
  } catch (err: any) {
    return { ok: false, error: `Manager unreachable: ${err?.message ?? String(err)}` };
  }
  if (!resp.ok) {
    return { ok: false, error: `Failed to list agents: HTTP ${resp.status}` };
  }
  const data: any = await resp.json();
  const agents: PublicAgentEntry[] = (data.agents || []).map((a: any) => ({
    id: a.id,
    name: a.name,
    customer_domain: a.customer_domain ?? null,
    status: a.status ?? 'unknown',
    public_endpoint_url: a.public_endpoint_url ?? null,
  }));
  return { ok: true, agents };
}

// ─── removePublicAgent ───────────────────────────────────────────────────────

export async function removePublicAgent(
  ref: string,
  deps: PublicCommandDeps,
): Promise<PublicCommandOutcome> {
  // Fetch list first
  const listResult = await listPublicAgents(deps);
  if (!listResult.ok) return listResult;

  const needle = ref.toLowerCase();
  const found = listResult.agents.find(
    (a) =>
      a.name.toLowerCase() === needle ||
      (a.customer_domain ?? '').toLowerCase() === needle,
  );
  if (!found) {
    return {
      ok: false,
      error: `No public agent found matching "${ref}". Run /public list to see registered agents.`,
    };
  }

  let resp: Response;
  try {
    resp = await deps.fetch(`${deps.managerBaseUrl}/agents/${found.id}`, {
      method: 'DELETE',
      headers: publicHeaders(),
    }) as any;
  } catch (err: any) {
    return { ok: false, error: `Manager unreachable: ${err?.message ?? String(err)}` };
  }
  if (!resp.ok) {
    let errMsg = `Delete failed: HTTP ${resp.status}`;
    try {
      const errBody: any = await resp.json();
      errMsg = errBody.message || errBody.error || errMsg;
    } catch { /* use default */ }
    return { ok: false, error: errMsg };
  }

  return { ok: true, message: `Removed public agent "${found.name}" (${found.customer_domain ?? found.id})` };
}
