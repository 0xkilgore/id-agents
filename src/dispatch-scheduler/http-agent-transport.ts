// The ONLY production code that should issue a direct HTTP POST to an
// agent's /talk endpoint. Everything else enqueues a Dispatch doc and
// lets the scheduler call this transport.
//
// Maps HTTP semantics to the AgentTransportResult discriminated union
// the classifier consumes. Network failures map to cause:"transport"
// (retryable); HTTP responses are passed through with their status +
// body for the classifier to decide retryable/auth/agent_error.

import type {
  AgentTransport,
  AgentTransportResult,
} from "./scheduler-service.js";
import type { DispatchDoc } from "./types.js";

export interface HttpAgentTransportOptions {
  resolveTargetUrl(doc: DispatchDoc): Promise<string | null> | string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Spec 054 v2 review fix: prepend a small visible dispatch metadata
// block to the message body so plain-text agent contexts (Claude-CLI
// session prompts) see the canonical dispatch_id. Exported for the
// transport guard test.
export function buildScheduledMessage(doc: DispatchDoc): string {
  const header =
    `[dispatch_id: ${doc.dispatch_phid}]\n` +
    `[query_id: ${doc.query_id}]\n\n`;
  return header + doc.body_markdown;
}

export class HttpAgentTransport implements AgentTransport {
  private resolveTargetUrl: HttpAgentTransportOptions["resolveTargetUrl"];
  private timeoutMs: number;

  constructor(opts: HttpAgentTransportOptions) {
    this.resolveTargetUrl = opts.resolveTargetUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendTalk(doc: DispatchDoc): Promise<AgentTransportResult> {
    const target = await this.resolveTargetUrl(doc);
    if (!target) {
      return {
        ok: false,
        status: 0,
        body: `no target URL for agent "${doc.to_agent}"`,
        cause: "http",
      };
    }
    const url = `${target.replace(/\/+$/, "")}/talk`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Spec 054 v2 review fix: every scheduler-launched /talk MUST
        // carry canonical dispatch metadata. Two delivery channels:
        //   1. JSON body fields: dispatch_id, query_id - for agents
        //      whose /talk handler reads the request body directly.
        //   2. A prepended metadata block on `message` - for agents
        //      that only see the prompt text (Claude-CLI sessions
        //      typically only get the message string).
        // Both must be present so PROTOCOL_DEFAULTS's instruction to
        // "call /agent-needs-input with the manager dispatch_id from
        // your /talk metadata" actually works end-to-end.
        body: JSON.stringify({
          message: buildScheduledMessage(doc),
          from: doc.from_actor,
          dispatch_id: doc.dispatch_phid,
          query_id: doc.query_id,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        return {
          ok: false,
          status: resp.status,
          body: text,
          cause: "http",
        };
      }
      let data: { query_id?: string } = {};
      try {
        data = (await resp.json()) as { query_id?: string };
      } catch {
        // Body wasn't JSON. The classifier sees status:200 + empty body
        // → falls into agent_error (which is the right semantics here:
        // the agent accepted but gave us nothing actionable).
        return {
          ok: false,
          status: resp.status,
          body: "non-json response",
          cause: "http",
        };
      }
      if (!data.query_id) {
        // Accepted but no agent_query_id — scheduler treats this as a
        // wedged start; the next tick's wedge sweep reaps + requeues.
        return { ok: true, agent_query_id: "" };
      }
      return { ok: true, agent_query_id: data.query_id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        body: "",
        cause: "transport",
        transportError: message,
      };
    }
  }
}
