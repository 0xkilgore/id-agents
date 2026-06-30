// Build-pools — public surface (Stage A; consumed by admission/daemon in Stage C).

export type {
  BuildPool,
  BuilderSlot,
  BuilderState,
  PoolId,
  RepoAlias,
} from "./types.js";
export { BuildPoolRegistry } from "./registry.js";
export {
  selectBuilder,
  isAvailable,
  isOnline,
  CODEX_ONLY_LOAD_LOOP_ALLOWED_AGENTS,
  DEFAULT_ONLINE_WINDOW_MS,
  type SelectOptions,
} from "./select.js";
