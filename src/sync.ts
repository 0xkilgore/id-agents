// SPDX-License-Identifier: MIT

import type { AgentSpec } from './config-parser.js';
import type { AgentRow } from './db/types.js';
import { resolveRuntime, getDefaultModelForRuntime } from './runtime/registry.js';
import type { HarnessType } from './harness/types.js';

export type SyncCategory = 'new' | 'removed' | 'changed' | 'unchanged';

export interface SyncItem {
  name: string;
  category: SyncCategory;
  changes?: string[];
}

export interface SyncPlan {
  added: SyncItem[];
  removed: SyncItem[];
  changed: SyncItem[];
  unchanged: SyncItem[];
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

const DIFF_FIELDS = [
  'model',
  'runtime',
  'plugins',
  'skills',
  'heartbeat',
  'allowedTools',
  'description',
  'domain',
  'tokenId',
  'workingDirectory',
] as const;

function normalizePlugins(plugins?: Array<{ name: string; path?: string }> | null): string {
  if (!plugins || plugins.length === 0) return '';
  return plugins
    .map(p => p.name)
    .sort()
    .join(',');
}

function normalizeSkills(skills?: string[] | null): string {
  if (!skills || skills.length === 0) return '';
  return [...skills].sort().join(',');
}

function normalizeAllowedTools(tools?: string[] | null): string {
  if (!tools || tools.length === 0) return '';
  return [...tools].sort().join(',');
}

function normalizeRuntime(runtime: string | undefined, defaultRuntime?: string): string {
  return resolveRuntime((runtime || defaultRuntime) as HarnessType);
}

function normalizeModel(model: string | undefined, runtime: string | undefined, defaultModel?: string): string {
  const resolved = resolveRuntime(runtime as HarnessType);
  return model || getDefaultModelForRuntime(resolved, defaultModel);
}

/**
 * Extracts comparable field values from a config AgentSpec.
 */
function configFields(spec: AgentSpec, defaultModel?: string): Record<string, string> {
  const runtime = normalizeRuntime(spec.runtime);
  return {
    model: normalizeModel(spec.model, spec.runtime, defaultModel),
    runtime,
    plugins: normalizePlugins(spec.plugins),
    skills: normalizeSkills(spec.skills),
    heartbeat: spec.heartbeat ? (typeof spec.heartbeat === 'number' ? String(spec.heartbeat) : JSON.stringify({ interval: spec.heartbeat.interval, message: spec.heartbeat.message })) : '',
    allowedTools: normalizeAllowedTools(spec.allowedTools),
    description: spec.description || '',
    domain: spec.domain || '',
    tokenId: spec.tokenId || '',
    workingDirectory: spec.workingDirectory || '',
  };
}

/**
 * Extracts comparable field values from a running DB AgentRow.
 */
function runningFields(row: AgentRow): Record<string, string> {
  const meta = (row.metadata || {}) as Record<string, any>;
  return {
    model: row.model || '',
    runtime: normalizeRuntime(row.runtime),
    plugins: normalizePlugins(meta.plugins),
    skills: normalizeSkills(meta.skills),
    heartbeat: meta.heartbeat === true ? 'enabled' : '',
    allowedTools: normalizeAllowedTools(meta.allowed_tools),
    description: meta.description || '',
    domain: row.domain || '',
    tokenId: row.token_id || '',
    workingDirectory: row.working_directory || '',
  };
}

/**
 * Compute the diff between a config spec and a running agent.
 * Returns the list of field names that differ, or empty if unchanged.
 */
export function diffAgent(spec: AgentSpec, row: AgentRow, defaultModel?: string): string[] {
  const cfg = configFields(spec, defaultModel);
  const run = runningFields(row);
  const changes: string[] = [];

  for (const field of DIFF_FIELDS) {
    // heartbeat: config has structured data, DB just stores a boolean flag.
    // Compare presence only: if config has heartbeat and DB doesn't (or vice versa).
    if (field === 'heartbeat') {
      const cfgHas = !!spec.heartbeat;
      const runHas = run.heartbeat === 'enabled';
      if (cfgHas !== runHas) changes.push(field);
      continue;
    }

    // workingDirectory: only compare when the config explicitly sets one.
    // Auto-generated directories (based on agent ID) always differ.
    if (field === 'workingDirectory') {
      if (cfg[field] && cfg[field] !== run[field]) {
        changes.push(field);
      }
      continue;
    }

    if (cfg[field] !== run[field]) {
      changes.push(field);
    }
  }

  return changes;
}

/**
 * Given a list of config agent specs and a list of running DB rows,
 * produce a SyncPlan categorizing each agent.
 *
 * Agents are matched by name (config name or domain, matching DB row name).
 */
export function computeSyncPlan(
  configAgents: AgentSpec[],
  runningAgents: AgentRow[],
  defaultModel?: string,
): SyncPlan {
  const plan: SyncPlan = { added: [], removed: [], changed: [], unchanged: [] };

  const runningByName = new Map<string, AgentRow>();
  for (const row of runningAgents) {
    runningByName.set(row.name, row);
  }

  const configNames = new Set<string>();

  for (const spec of configAgents) {
    const name = spec.domain || spec.name;
    configNames.add(name);

    const row = runningByName.get(name);
    if (!row) {
      plan.added.push({ name, category: 'new' });
      continue;
    }

    const changes = diffAgent(spec, row, defaultModel);
    if (changes.length > 0) {
      plan.changed.push({ name, category: 'changed', changes });
    } else {
      plan.unchanged.push({ name, category: 'unchanged' });
    }
  }

  // Agents in DB but not in config → removed
  for (const row of runningAgents) {
    if (!configNames.has(row.name)) {
      // Also check alias — config might use the short name but DB stores domain
      const alias = (row.metadata as any)?.alias;
      if (alias && configNames.has(alias)) continue;
      plan.removed.push({ name: row.name, category: 'removed' });
    }
  }

  return plan;
}

/**
 * Format a sync plan into a human-readable summary line.
 */
export function formatSyncSummary(plan: SyncPlan): string {
  return `Added ${plan.added.length}, updated ${plan.changed.length}, removed ${plan.removed.length}, unchanged ${plan.unchanged.length}`;
}

/**
 * Format a verbose sync plan with per-agent details.
 */
export function formatSyncVerbose(plan: SyncPlan): string {
  const lines: string[] = [];

  for (const item of plan.added) {
    lines.push(`  + ${item.name} (new)`);
  }
  for (const item of plan.changed) {
    lines.push(`  ~ ${item.name} (changed: ${item.changes?.join(', ')})`);
  }
  for (const item of plan.removed) {
    lines.push(`  - ${item.name} (removed)`);
  }
  for (const item of plan.unchanged) {
    lines.push(`  = ${item.name} (unchanged)`);
  }

  return lines.join('\n');
}
