// B0 (2026-06-08): production-side adapter that maps a `QueriesRepository`
// + a single `teamId` into the scheduler's `QueryEvidenceClient` seam.
//
// The scheduler uses `agent_query_id` to look up evidence — same identifier
// the agent harness writes into `queries.query_id` via `addNews`. The
// look-up is team-scoped so a misrouted phid cannot read another team's
// query row.

import type { QueriesRepository } from "../db/db-service.js";
import type {
  QueryEvidence,
  QueryEvidenceClient,
} from "./scheduler-service.js";

export interface QueriesEvidenceClientOptions {
  queries: QueriesRepository;
  teamId: string;
}

export class QueriesEvidenceClient implements QueryEvidenceClient {
  private readonly queries: QueriesRepository;
  private readonly teamId: string;

  constructor(opts: QueriesEvidenceClientOptions) {
    this.queries = opts.queries;
    this.teamId = opts.teamId;
  }

  async getEvidence(agentQueryId: string): Promise<QueryEvidence | null> {
    const row = await this.queries.getByQueryIdForTeam(this.teamId, agentQueryId);
    if (!row) return null;
    return {
      status: row.status,
      last_output_at:
        typeof row.last_output_at === "number" ? row.last_output_at : null,
    };
  }
}
