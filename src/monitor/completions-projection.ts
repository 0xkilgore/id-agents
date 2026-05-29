// Monitor — Completions projection.
// Correlates query.received + query.completed news events by agent + query_id.
// Computes duration from canonical event timestamps only.
// Read-only; no side effects.

import type {
  InFlightQueryRow,
  RecentCompletionRow,
  PromotionOutcomeRow,
  SourceCoverageRow,
} from './types.js';

export interface NewsEvent {
  id: number;
  agent_id: string | null;
  timestamp: number;
  type: string;
  message: string | null;
  data: Record<string, unknown> | null;
  query_id: string | null;
  owner_id: string;
}

interface ReceivedEvent {
  agent: string;
  query_id: string;
  from: string | null;
  received_ts: number;
  event_type: 'query.received' | 'schedule.received';
}

interface CompletedEvent {
  agent: string;
  query_id: string;
  completed_ts: number;
  result_preview: string | null;
}

export function projectCompletions(
  events: NewsEvent[],
  generatedAt: number,
): {
  in_flight: InFlightQueryRow[];
  recent_completions: RecentCompletionRow[];
  source_coverage: Map<string, { newest_ts: number | null; error: string | null }>;
} {
  // Collect received and completed events, keyed by agent + query_id.
  const receivedMap = new Map<string, ReceivedEvent>();
  const completedMap = new Map<string, CompletedEvent>();
  const agentCoverage = new Map<string, { newest_ts: number | null; error: string | null }>();

  for (const ev of events) {
    const agent = ev.owner_id || ev.agent_id || '';
    if (!agent) continue;

    // Track coverage
    const cov = agentCoverage.get(agent);
    if (!cov) {
      agentCoverage.set(agent, { newest_ts: ev.timestamp, error: null });
    } else if (cov.newest_ts === null || ev.timestamp > cov.newest_ts) {
      cov.newest_ts = ev.timestamp;
    }

    if (!ev.query_id) continue;
    const key = `${agent}:${ev.query_id}`;

    if (ev.type === 'query.received' || ev.type === 'schedule.received') {
      const existing = receivedMap.get(key);
      // Use the earliest received event for this agent+query
      if (!existing || ev.timestamp < existing.received_ts) {
        const from = extractFrom(ev);
        receivedMap.set(key, {
          agent,
          query_id: ev.query_id,
          from: ev.type === 'schedule.received' ? 'schedule' : from,
          received_ts: ev.timestamp,
          event_type: ev.type as 'query.received' | 'schedule.received',
        });
      }
    } else if (ev.type === 'query.completed') {
      const existing = completedMap.get(key);
      // Use the latest completed event
      if (!existing || ev.timestamp > existing.completed_ts) {
        completedMap.set(key, {
          agent,
          query_id: ev.query_id,
          completed_ts: ev.timestamp,
          result_preview: extractResultPreview(ev),
        });
      }
    }
  }

  // Build in-flight: received but no matching completed
  const inFlight: InFlightQueryRow[] = [];
  for (const [key, received] of receivedMap) {
    if (completedMap.has(key)) continue;
    inFlight.push({
      agent: received.agent,
      query_id: received.query_id,
      from: received.from,
      received_ts: received.received_ts,
      elapsed_ms: generatedAt - received.received_ts,
      event_type: received.event_type,
    });
  }
  // Sort by largest elapsed first
  inFlight.sort((a, b) => b.elapsed_ms - a.elapsed_ms);

  // Build recent completions: matched received + completed pairs
  const recentCompletions: RecentCompletionRow[] = [];
  for (const [key, completed] of completedMap) {
    const received = receivedMap.get(key);
    if (!received) {
      // Completed without a received event — flag in coverage, skip row
      const cov = agentCoverage.get(completed.agent);
      if (cov) {
        cov.error = cov.error
          ? `${cov.error}; missing received for ${completed.query_id}`
          : `missing received for ${completed.query_id}`;
      }
      continue;
    }

    const duration_ms = completed.completed_ts - received.received_ts;
    if (duration_ms < 0) {
      // Negative duration — flag ordering error, skip row
      const cov = agentCoverage.get(received.agent);
      if (cov) {
        cov.error = cov.error
          ? `${cov.error}; negative duration for ${received.query_id}`
          : `negative duration for ${received.query_id}`;
      }
      continue;
    }

    recentCompletions.push({
      agent: received.agent,
      query_id: received.query_id,
      from: received.from,
      received_ts: received.received_ts,
      completed_ts: completed.completed_ts,
      duration_ms,
      result_preview: completed.result_preview,
    });
  }
  // Sort by completed timestamp descending
  recentCompletions.sort((a, b) => b.completed_ts - a.completed_ts);

  return { in_flight: inFlight, recent_completions: recentCompletions, source_coverage: agentCoverage };
}

export function projectPromotionOutcomes(
  events: NewsEvent[],
): PromotionOutcomeRow[] {
  const outcomes: PromotionOutcomeRow[] = [];

  // Look for query.completed events whose data includes a promotion block
  // (from /agent-done payloads persisted as news or dispatch queue).
  // Also check reply events that may contain promotion data.
  for (const ev of events) {
    if (ev.type !== 'query.completed' && ev.type !== 'reply') continue;
    if (!ev.data) continue;

    const promotion = (ev.data as Record<string, unknown>).promotion as {
      required?: boolean;
      completed?: boolean;
      repos?: Array<{
        source_branch?: string;
        promoted_sha?: string;
        pushed?: boolean;
        verified?: boolean;
        base?: string;
        remote_main_sha?: string;
      }>;
    } | undefined;

    if (!promotion || !Array.isArray(promotion.repos)) continue;

    const agent = ev.owner_id || ev.agent_id || null;
    const source = ev.type === 'query.completed' ? 'agent-done-promotion' : 'reply-promotion-block';

    for (const repo of promotion.repos) {
      outcomes.push({
        query_id: ev.query_id,
        agent,
        branch: repo.source_branch ?? null,
        commit: repo.promoted_sha ?? null,
        promoted_to_main: promotion.completed ?? null,
        pushed: repo.pushed ?? null,
        verified: repo.verified != null
          ? (repo.verified === true && repo.remote_main_sha === repo.promoted_sha)
          : null,
        base: repo.base ?? null,
        remote_main_sha: repo.remote_main_sha ?? null,
        source: source as PromotionOutcomeRow['source'],
      });
    }
  }

  return outcomes;
}

export function buildSourceCoverage(
  agentCoverage: Map<string, { newest_ts: number | null; error: string | null }>,
): SourceCoverageRow[] {
  const rows: SourceCoverageRow[] = [];
  for (const [agent, cov] of agentCoverage) {
    rows.push({
      agent,
      news_seen: cov.newest_ts !== null,
      newest_news_ts: cov.newest_ts,
      error: cov.error,
    });
  }
  return rows;
}

function extractFrom(ev: NewsEvent): string | null {
  if (ev.data && typeof ev.data === 'object') {
    const from = (ev.data as Record<string, unknown>).from;
    if (typeof from === 'string') return from;
  }
  return null;
}

function extractResultPreview(ev: NewsEvent): string | null {
  if (ev.message) return ev.message.slice(0, 200);
  if (ev.data && typeof ev.data === 'object') {
    const result = (ev.data as Record<string, unknown>).result;
    if (typeof result === 'string') return result.slice(0, 200);
    if (result && typeof result === 'object') {
      const reply = (result as Record<string, unknown>).reply ?? (result as Record<string, unknown>).result;
      if (typeof reply === 'string') return reply.slice(0, 200);
    }
  }
  return null;
}
