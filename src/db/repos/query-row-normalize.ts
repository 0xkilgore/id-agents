// SPDX-License-Identifier: MIT
//
// RD-010: owner_kind/owner_id and `result` shape were only normalized on
// read in the SQLite queries-repo, so a Postgres-backed deployment could
// return different values for the same underlying row (stale/empty
// owner_kind+owner_id for legacy rows, and `result: {}` vs `result: null`
// for a still-pending query). Both repos now call this single function so
// the two backends can't drift again.

import type { InboxOwnerKind, QueryRow } from '../types.js';
import { parseJsonObject } from '../db-json.js';

export function resolveQueryOwnership(
  teamId: string,
  agentId: string | null,
  override?: { owner_kind: InboxOwnerKind; owner_id: string },
): { owner_kind: InboxOwnerKind; owner_id: string } {
  if (override) return override;
  if (agentId != null && agentId !== '') {
    if (agentId.startsWith('manager-')) {
      return { owner_kind: 'manager', owner_id: teamId };
    }
    return { owner_kind: 'agent', owner_id: agentId };
  }
  throw new Error('resolveQueryOwnership: ownership override required when agentId is null');
}

export function normalizeQueryRow(row: any): QueryRow | null {
  if (!row) return null;
  const agent_id =
    row.agent_id != null && row.agent_id !== '' ? String(row.agent_id) : null;
  const team_id = String(row.team_id ?? '');
  const owner_kind: InboxOwnerKind =
    row.owner_kind === 'manager' || row.owner_kind === 'agent'
      ? row.owner_kind
      : agent_id?.startsWith('manager-')
        ? 'manager'
        : 'agent';
  const owner_id =
    row.owner_id != null && String(row.owner_id) !== ''
      ? String(row.owner_id)
      : owner_kind === 'manager'
        ? team_id
        : (agent_id ?? '');
  return {
    ...row,
    team_id,
    agent_id,
    owner_kind,
    owner_id,
    result: row.result == null ? null : parseJsonObject(row.result),
  };
}
