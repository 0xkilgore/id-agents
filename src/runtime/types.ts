// SPDX-License-Identifier: MIT
/**
 * Runtime metadata and capability types.
 *
 * Runtime profiles describe how an agent executes LLM work. They are separate
 * from agent topology (`type`) so new runtimes can be added without spreading
 * provider-specific conditionals through the codebase.
 */

import type { HarnessType } from '../harness/types.js';

export type RuntimeId = HarnessType;

export type RuntimeSessionPolicy = 'persistent' | 'fresh-per-query';

export interface RuntimeAuthConfig {
  mode: 'api-key' | 'cli-login';
  provider: string;
  requiredEnv?: string[];
}

export interface RuntimeCapabilities {
  supportsResume: boolean;
  supportsPlugins: boolean;
  supportsAllowedTools: boolean;
}

export interface RuntimeProfile {
  id: RuntimeId;
  canonicalId: RuntimeId;
  displayName: string;
  providerName: string;
  defaultModel: string;
  sessionPolicy: RuntimeSessionPolicy;
  auth: RuntimeAuthConfig;
  capabilities: RuntimeCapabilities;
}

export interface RuntimeValidationIssue {
  code: string;
  message: string;
}
