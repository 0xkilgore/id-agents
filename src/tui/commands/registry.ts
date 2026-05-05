// Command catalog for the TUI command bar (Phase 1).
//
// Phase 1 exposes exactly one read-only command (`agents`). The catalog
// shape is designed so Phase 2+ can add more commands without touching
// the bar/result components or App-level wiring.

import { fetchAgentsAllTeams, fetchTeams } from '../api/manager.js';

export interface CommandContext {
  manager: string;
  executor: string;
  signal: AbortSignal;
  args: string[];
}

export interface CommandSpec {
  name: string;
  description: string;
  run: (ctx: CommandContext) => Promise<unknown>;
}

const agentsCommand: CommandSpec = {
  name: 'agents',
  description: 'List all agents across all teams',
  run: async ({ manager, signal }) => {
    const teams = await fetchTeams(manager, signal);
    const agents = await fetchAgentsAllTeams(manager, teams, signal);
    return { count: agents.length, agents };
  },
};

const REGISTRY: Record<string, CommandSpec> = {
  agents: agentsCommand,
};

export function lookupCommand(name: string): CommandSpec | null {
  return REGISTRY[name] ?? null;
}

export function knownCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

// Splits a raw input line (with or without leading `:` / `/`) into
// command name and args. Returns null when the line is empty after
// stripping the prefix.
export function parseCommandLine(raw: string): { name: string; args: string[] } | null {
  const stripped = raw.replace(/^[:/]+/, '').trim();
  if (!stripped) return null;
  const parts = stripped.split(/\s+/);
  return { name: parts[0]!, args: parts.slice(1) };
}
