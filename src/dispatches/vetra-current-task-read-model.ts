// SPDX-License-Identifier: MIT
/**
 * VetraCurrentTaskReadModel — projects Switchboard GraphQL dispatch
 * documents into AgentCurrentTaskSnapshot. Active when
 * USE_VETRA_DISPATCHES=true.
 *
 * Failure semantics: any of HTTP, malformed payload, missing required
 * fields, or impossible projection state (multiple open documents with
 * identical timestamps for one agent) throw VetraReadFallbackError.
 * The manager route catches that and falls back to SQLite while
 * flipping degraded_source=true on the response.
 *
 * Plan: docs/superpowers/plans/2026-05-08-vetra-readside-dashboard.md
 * Phase 2 / Task 3.
 */

import type {
  AgentCurrentTaskReadModel,
  AgentCurrentTaskSnapshot,
  CurrentTaskStatus,
} from './current-task-read-model.js';
import { extractCurrentTaskTitle } from './current-task-title.js';
import type { SwitchboardClient, VetraDispatchDocument } from '../vetra/switchboard-client.js';

export class VetraReadFallbackError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'VetraReadFallbackError';
  }
}

const OPEN_STATUSES = new Set(['QUEUED', 'IN_FLIGHT']);

function asISOString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function toLowerStatus(s: string): CurrentTaskStatus {
  return s === 'IN_FLIGHT' ? 'in_flight' : 'queued';
}

function firstArtifactPath(doc: VetraDispatchDocument): string | null {
  if (!Array.isArray(doc.artifacts) || doc.artifacts.length === 0) return null;
  const first = doc.artifacts[0];
  return typeof first?.path === 'string' ? first.path : null;
}

export class VetraCurrentTaskReadModel implements AgentCurrentTaskReadModel {
  constructor(private readonly client: SwitchboardClient) {}

  async getCurrentTaskByAgent(agentIds: string[]): Promise<AgentCurrentTaskSnapshot[]> {
    let docs: VetraDispatchDocument[];
    try {
      docs = await this.client.queryOpenDispatches(agentIds);
    } catch (err: any) {
      throw new VetraReadFallbackError(
        `Vetra read failed: ${err?.message ?? String(err)}`,
        err,
      );
    }

    // Group by agent, keep only open statuses, validate shape.
    const groups = new Map<string, VetraDispatchDocument[]>();
    for (const raw of docs) {
      const isoAt = asISOString(raw?.dispatched_at);
      if (
        !raw ||
        typeof raw.to_agent !== 'string' ||
        !isoAt ||
        typeof raw.status !== 'string'
      ) {
        throw new VetraReadFallbackError(
          `Vetra row missing required fields: ${JSON.stringify(raw).slice(0, 160)}`,
        );
      }
      if (!OPEN_STATUSES.has(raw.status)) continue;
      const list = groups.get(raw.to_agent) ?? [];
      list.push({ ...raw, dispatched_at: isoAt });
      groups.set(raw.to_agent, list);
    }

    return agentIds.map((agentId) => {
      const list = groups.get(agentId);
      if (!list || list.length === 0) {
        return { agent_id: agentId, current_task: null, degraded_source: false };
      }
      list.sort((a, b) => Date.parse(b.dispatched_at) - Date.parse(a.dispatched_at));
      const top = list[0];
      // Conflicting: two top candidates with identical timestamps.
      if (list.length > 1 && Date.parse(list[1].dispatched_at) === Date.parse(top.dispatched_at)) {
        throw new VetraReadFallbackError(
          `Multiple open Vetra dispatches with identical dispatched_at for agent ${agentId}`,
        );
      }
      return {
        agent_id: agentId,
        current_task: {
          source: 'vetra',
          dispatch_id: top.dispatch_id,
          query_id: top.query_id ?? null,
          title: extractCurrentTaskTitle(top.body_markdown ?? ''),
          started_at: top.dispatched_at,
          status: toLowerStatus(top.status),
          waiting_on_human: false,
          verify_status: top.verify_status ? top.verify_status.toLowerCase() : null,
          artifact_path: firstArtifactPath(top),
        },
        degraded_source: false,
      };
    });
  }
}
