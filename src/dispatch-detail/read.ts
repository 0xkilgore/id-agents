import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";
import {
  readDispatchById,
  type DeriveOptions,
} from "../dispatch-scheduler/read-model.js";
import {
  buildDispatchDetailResponse,
  type DispatchDetailResponse,
  type DispatchDetailSourceRow,
} from "./build.js";

export async function readDispatchDetailById(
  adapter: DbAdapterLike,
  teamId: string,
  dispatchId: string,
  opts: DeriveOptions = {},
): Promise<DispatchDetailResponse | null> {
  const summary = await readDispatchById(adapter, teamId, dispatchId, opts);
  if (!summary) return null;
  const source = await readDispatchDetailSource(adapter, teamId, dispatchId);
  if (!source) return null;
  return buildDispatchDetailResponse(summary, source);
}

async function readDispatchDetailSource(
  adapter: DbAdapterLike,
  teamId: string,
  dispatchId: string,
): Promise<DispatchDetailSourceRow | null> {
  const { rows } = await adapter.query<DispatchDetailSourceRow>(
    `SELECT dispatch_phid, body_markdown, bounce_history_json, result_json,
            artifact_path, promotion_input_json
       FROM dispatch_scheduler_queue
       WHERE team_id = ? AND (dispatch_phid = ? OR query_id = ? OR agent_query_id = ?)
       LIMIT 1`,
    [teamId, dispatchId, dispatchId, dispatchId],
  );
  return rows[0] ?? null;
}
