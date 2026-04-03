// SPDX-License-Identifier: MIT
/**
 * Runtime-neutral alias for the per-agent REST server.
 *
 * `claude-agent-server.ts` remains the implementation file for compatibility,
 * but new code and docs should prefer this module name as the runtime layer
 * becomes more modular.
 */

export { ClaudeAgentServer as AgentRestServer } from './claude-agent-server.js';
export type { NewsItem } from './claude-agent-server.js';
