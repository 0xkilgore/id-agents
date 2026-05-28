// Supervisor v0 — Manager-side source reader.
// Reads from existing manager projections. All read-only.

import type {
  ActiveDispatch,
  TerminalDispatch,
  AgentStatus,
  NewsEntry,
} from './types.js';
import type { SupervisorSourceReader } from './watcher.js';

export interface DbAdapterLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ManagerSourceReaderOptions {
  adapter: DbAdapterLike;
  teamId: string;
}

export class ManagerSourceReader implements SupervisorSourceReader {
  private adapter: DbAdapterLike;
  private teamId: string;

  constructor(opts: ManagerSourceReaderOptions) {
    this.adapter = opts.adapter;
    this.teamId = opts.teamId;
  }

  async readActiveDispatches(): Promise<ActiveDispatch[]> {
    const { rows } = await this.adapter.query<{
      dispatch_phid: string;
      query_id: string;
      to_agent: string;
      status: string;
      started_at: string | null;
      updated_at: string;
      subject: string;
      promote: number | null;
      promotion_input_json: string | null;
    }>(
      `SELECT dispatch_phid, query_id, to_agent, status, started_at, updated_at,
              subject, promote, promotion_input_json
       FROM dispatch_scheduler_queue
       WHERE team_id = $1 AND status IN ('in_flight', 'queued', 'bounced')`,
      [this.teamId],
    );

    return rows.map(r => ({
      dispatch_phid: r.dispatch_phid,
      query_id: r.query_id,
      to_agent: r.to_agent,
      status: r.status,
      started_at: r.started_at,
      updated_at: r.updated_at,
      subject: r.subject,
      promote: r.promote == null ? true : Number(r.promote) === 1,
      promotion_input: parseJsonOrNull(r.promotion_input_json) as ActiveDispatch['promotion_input'],
    }));
  }

  async readTerminalDispatches(since: string): Promise<TerminalDispatch[]> {
    const { rows } = await this.adapter.query<{
      dispatch_phid: string;
      query_id: string;
      to_agent: string;
      status: string;
      completed_at: string | null;
      subject: string;
      failure_kind: string | null;
      failure_detail: string | null;
      promote: number | null;
      promotion_result_json: string | null;
      promotion_input_json: string | null;
    }>(
      `SELECT dispatch_phid, query_id, to_agent, status, completed_at, subject,
              failure_kind, failure_detail, promote, promotion_result_json, promotion_input_json
       FROM dispatch_scheduler_queue
       WHERE team_id = $1 AND status IN ('done', 'failed', 'cancelled')
         AND completed_at >= $2
       ORDER BY completed_at DESC
       LIMIT 100`,
      [this.teamId, since],
    );

    return rows.map(r => ({
      dispatch_phid: r.dispatch_phid,
      query_id: r.query_id,
      to_agent: r.to_agent,
      status: r.status,
      completed_at: r.completed_at,
      subject: r.subject,
      failure_kind: r.failure_kind,
      failure_detail: r.failure_detail,
      promote: r.promote == null ? true : Number(r.promote) === 1,
      promotion_result: parseJsonOrNull(r.promotion_result_json),
      promotion_input: parseJsonOrNull(r.promotion_input_json) as TerminalDispatch['promotion_input'],
    }));
  }

  async readWatchedAgents(): Promise<AgentStatus[]> {
    const { rows: agents } = await this.adapter.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status FROM agents WHERE team_id = $1 AND deleted_at IS NULL`,
      [this.teamId],
    );

    // Use latest news_items timestamp as "last seen" proxy.
    const { rows: lastSeen } = await this.adapter.query<{
      agent_id: string;
      last_ts: number;
    }>(
      `SELECT agent_id, MAX(timestamp) as last_ts
       FROM news_items
       WHERE team_id = $1
       GROUP BY agent_id`,
      [this.teamId],
    );
    const lastSeenMap = new Map(lastSeen.map(r => [r.agent_id, r.last_ts]));

    const { rows: activeCounts } = await this.adapter.query<{
      to_agent: string;
      cnt: number;
    }>(
      `SELECT to_agent, COUNT(*) as cnt
       FROM dispatch_scheduler_queue
       WHERE team_id = $1 AND status IN ('in_flight', 'queued')
       GROUP BY to_agent`,
      [this.teamId],
    );
    const countMap = new Map(activeCounts.map(r => [r.to_agent, Number(r.cnt)]));

    return agents.map(a => {
      const ts = lastSeenMap.get(a.id);
      return {
        agent_id: a.id,
        last_seen_at: ts ? new Date(Number(ts)).toISOString() : null,
        active_dispatches: countMap.get(a.id) ?? 0,
        status_state: a.status ?? 'unknown',
      };
    });
  }

  async readRecentNews(since: string): Promise<NewsEntry[]> {
    try {
      const sinceMs = new Date(since).getTime();
      const { rows } = await this.adapter.query<{
        id: number;
        agent_id: string;
        timestamp: number;
        message: string | null;
      }>(
        `SELECT id, agent_id, timestamp, message
         FROM news_items
         WHERE team_id = $1 AND timestamp >= $2
         ORDER BY timestamp DESC
         LIMIT 200`,
        [this.teamId, sinceMs],
      );

      return rows
        .filter(r => r.message != null)
        .map(r => ({
          id: String(r.id),
          agent_id: r.agent_id,
          ts: new Date(Number(r.timestamp)).toISOString(),
          message: r.message!,
        }));
    } catch {
      return [];
    }
  }
}

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
