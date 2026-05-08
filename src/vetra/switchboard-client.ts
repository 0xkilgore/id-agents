// SPDX-License-Identifier: MIT
/**
 * SwitchboardClient — narrow read-only GraphQL client for Vetra dispatch
 * documents. Used by VetraCurrentTaskReadModel to fetch open dispatches
 * for the dashboard fleet cards.
 *
 * Constraints (Phase 2 / Task 3 of vetra-readside-dashboard):
 *   - POST GraphQL only
 *   - 5s timeout via AbortController (override via opts.timeoutMs)
 *   - bearer auth only when token exists
 *   - no retries in v1
 *   - rich errors on non-2xx (HTTP status + short response preview)
 */

export interface VetraDispatchDocument {
  dispatch_id: string | number;
  to_agent: string;
  dispatched_at: string;
  status: string;
  body_markdown: string;
  query_id: string | null;
  verify_status: string | null;
  artifacts: Array<{ path: string }>;
}

export interface SwitchboardClientOpts {
  graphqlUrl: string;
  accessToken: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const OPEN_DISPATCHES_QUERY = `
  query OpenDispatches($agentIds: [String!]!) {
    openDispatches(toAgents: $agentIds) {
      dispatch_id
      to_agent
      dispatched_at
      status
      body_markdown
      query_id
      verify_status
      artifacts { path }
    }
  }
`;

export class SwitchboardClient {
  private readonly graphqlUrl: string;
  private readonly accessToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SwitchboardClientOpts) {
    this.graphqlUrl = opts.graphqlUrl;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async queryOpenDispatches(agentIds: string[]): Promise<VetraDispatchDocument[]> {
    if (agentIds.length === 0) return [];
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: OPEN_DISPATCHES_QUERY,
          variables: { agentIds },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const preview = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Switchboard ${res.status}: ${preview}`);
      }
      const json = (await res.json()) as { data?: { openDispatches?: VetraDispatchDocument[] }; errors?: unknown };
      if (json.errors || !json.data || !Array.isArray(json.data.openDispatches)) {
        const preview = JSON.stringify(json).slice(0, 200);
        throw new Error(`Switchboard malformed response: ${preview}`);
      }
      return json.data.openDispatches;
    } finally {
      clearTimeout(timer);
    }
  }
}
