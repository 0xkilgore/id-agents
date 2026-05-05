// Command catalog for the TUI command bar.
//
// Phase 1 introduced the bar and one entry (`agents`).
// Phase 2 fills in the safe-default read-only catalog. Entries that
// don't take args run as bare commands; entries that accept args
// forward them verbatim. Multi-token forms (e.g. `schedule list`,
// `schedule show <id>`, `task list`) are reached by typing the
// subcommand after the top-level name — tab completion only operates
// on the top-level token.

import { fetchAgentsAllTeams, fetchTeams, runRemoteCommand } from '../api/manager.js';

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

// Build a CommandSpec that forwards to the manager's `/remote` endpoint
// using the action name plus whatever args the user typed after it.
// The result body is whatever the handler returned in `result` — the
// renderer pretty-prints it, so the shape per command is preserved.
function remote(name: string, description: string): CommandSpec {
  return {
    name,
    description,
    run: async ({ manager, executor, signal, args }) => {
      const command = ['/' + name, ...args].join(' ');
      return runRemoteCommand(manager, executor, command, signal);
    },
  };
}

// `agents` keeps the Phase 1 cross-team semantics (the manager's
// `/remote` `agents` handler is single-team). Phase 1 acceptance still
// applies: `:agents` from any view returns the merged agent list.
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
  status: remote('status', 'Team health summary (running/offline counts + per-agent health)'),
  teams: remote('teams', 'List all teams in the manager DB'),
  team: remote('team', 'Show the active team (id, name, agent count)'),
  configs: remote('configs', 'List configs/*.yaml deployment files'),
  news: remote('news', 'List news items for an agent (`:news <agent>`)'),
  heartbeats: remote('heartbeats', 'List agents with heartbeat enabled'),
  schedule: remote('schedule', 'Schedules: `:schedule list` | `:schedule show <id>`'),
  task: remote('task', 'Tasks: `:task list` (default) | other subcommands'),
  output: remote('output', "List files in an agent's ./output dir (`:output <agent>`)"),
  artifact: remote('artifact', 'Read one artifact (`:artifact <agent> <path>`)'),
  meta: remote('meta', 'Show agent metadata (`:meta <agent>`)'),
  list: remote('list', 'Show all pending queries in the active team'),
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

// Top-level tab completion. Operates only on the first token of the
// buffer (i.e. before any whitespace). Returns the new buffer string,
// or null if no completion can be applied. Behavior:
//   - exactly one prefix match → completes to the full name + trailing space
//   - multiple matches → extends to the longest common prefix (no space)
//   - zero matches or already past first token → null
export function completeCommand(buffer: string): string | null {
  if (buffer.length < 1) return null;
  const sigil = buffer[0];
  if (sigil !== ':' && sigil !== '/') return null;
  const rest = buffer.slice(1);
  if (rest.includes(' ')) return null;
  const matches = knownCommandNames().filter((n) => n.startsWith(rest));
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    if (matches[0] === rest) return null;
    return sigil + matches[0] + ' ';
  }
  let prefix = matches[0]!;
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.length && prefix[i] === m[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length <= rest.length) return null;
  return sigil + prefix;
}
