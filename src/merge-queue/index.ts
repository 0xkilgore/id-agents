// Merge-queue — public surface.

export type {
  MergeRequest,
  MergeRequestSubmission,
  MergeState,
  MergeStrategy,
  MergeFailure,
  MergeFailureReason,
} from "./types.js";
export {
  mergeIdempotencyKey,
  isTerminalMergeState,
  MERGE_QUEUE_SCHEMA_VERSION,
  DEFAULT_MAX_ATTEMPTS,
} from "./types.js";
export {
  migrateMergeQueueTables,
  enqueueMergeRequest,
  getMergeRequest,
  getByIdempotencyKey,
  dequeueOldestQueued,
  updateMergeRequest,
  listMergeRequests,
  type EnqueueResult,
  type MergeRequestPatch,
} from "./storage.js";
export {
  drainOneMergeRequest,
  drainRepo,
  type MergeWorkerDeps,
  type MergeGitDeps,
  type MergePromoteResult,
} from "./worker.js";
