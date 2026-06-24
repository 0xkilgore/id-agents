// Boot-time agent spawn reconciliation (CTO build-pool spec, part 3b).
//
// The manager's launchd entry runs `dist/start-agent-manager.js` and does NOT
// spawn agents on boot — a prior boot path deployed from a (now-deleted) team
// yaml. So agents that were registered but never started sit in the SQLite
// roster as `status="pending"` forever (e.g. the build-pool members
// brunel/hopper/eames/gaudi). This makes them come up on every manager boot.
//
// Spawning goes through `spawnLocalAgentProcess` → `buildLocalAgentEnv`, which
// strips the parent session-handoff vars (CLAUDE_CODE_OAUTH_TOKEN, …) via
// `filterClaudeEnvVars` and pins `resolveManagerNode()` — so boot-spawned
// builders are env-clean (no 401) and ABI-safe by construction.

import { isRemoteEndpointRuntime } from "../runtime/registry.js";

/** The agent-row fields the boot-spawn filter inspects. */
export interface BootSpawnCandidate {
  status: string;
  type: string;
  port: number;
  runtime: string;
}

/**
 * A roster agent the manager should (re)spawn at boot: registered but never
 * started (`status==="pending"`), a locally-spawnable runtime, with a real
 * port. Virtual/external agents (port 0) and remote-endpoint runtimes
 * (public-agent-remote) are NEVER spawned here — they live elsewhere.
 *
 * Intentionally narrow to `pending`: `stopped` is an operator's deliberate
 * "off", and `running` rows are handled by the live fleet (their detached
 * processes survive a manager restart).
 */
export function isBootSpawnableAgent(a: BootSpawnCandidate): boolean {
  if (a.status !== "pending") return false;
  if (a.type === "virtual") return false;
  if (!a.port || a.port <= 0) return false;
  if (isRemoteEndpointRuntime(a.runtime)) return false;
  return true;
}
