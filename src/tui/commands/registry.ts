// Command catalog for the TUI command bar.
//
// Phase 1 introduced the bar and one entry (`agents`).
// Phase 2 filled in the safe-default read-only catalog plus tab
// completion and key-field highlighting.
// Phase 3 adds the powerful (mutating) command families behind a single
// Y/N confirmation gate: `agent <name> rebuild|start|stop|wallet`,
// `model`, `deploy`, `sync`, `register`, `registry push`, schedule/task
// mutators, and `heartbeat enable|disable`. The plural `agents rebuild`
// is intentionally NOT included — Track B owns that command and is
// paused pending the operator's A/B/A-admin-gated pick.

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
  // Returns true when the args trigger a destructive/mutating handler
  // and the user should see a Y/N prompt before dispatch. Absent or
  // returning false → run immediately (Phase 1/2 behavior).
  shouldConfirm?: (args: string[]) => boolean;
  // One-line preview shown under the prompt to make destructive ops
  // self-documenting (e.g., `rebuild agent foo`). Absent or returning
  // null → renderer falls back to the raw command line.
  confirmPreview?: (args: string[]) => string | null;
}

// Build a CommandSpec that forwards to the manager's `/remote` endpoint
// using the action name plus whatever args the user typed after it.
function remote(
  name: string,
  description: string,
  extras: Pick<CommandSpec, 'shouldConfirm' | 'confirmPreview'> = {},
): CommandSpec {
  return {
    name,
    description,
    run: async ({ manager, executor, signal, args }) => {
      const command = ['/' + name, ...args].join(' ');
      return runRemoteCommand(manager, executor, command, signal);
    },
    ...extras,
  };
}

// `agents` keeps the Phase 1 cross-team semantics — the manager's
// `/remote` `agents` handler is single-team. Phase 1 acceptance still
// holds: `:agents` from any view returns the merged agent list.
const agentsCommand: CommandSpec = {
  name: 'agents',
  description: 'List all agents across all teams',
  run: async ({ manager, signal }) => {
    const teams = await fetchTeams(manager, signal);
    const agents = await fetchAgentsAllTeams(manager, teams, signal);
    return { count: agents.length, agents };
  },
};

// ── Phase 3 predicates ─────────────────────────────────────────────
// These keep a single catalog entry per top-level token (`schedule`,
// `task`, `registry`, `agent`, `heartbeat`) and decide on the args
// alone whether to pop the confirmation prompt.

const SCHEDULE_MUTATORS = new Set(['add', 'pause', 'resume', 'remove']);
const TASK_MUTATORS = new Set(['create', 'claim', 'done', 'remove', 'delete']);
const AGENT_MUTATORS = new Set(['rebuild', 'start', 'stop', 'wallet']);
const HEARTBEAT_MUTATORS = new Set(['enable', 'disable']);

const REGISTRY: Record<string, CommandSpec> = {
  // ── Phase 1 ──────────────────────────────────────────────────────
  agents: agentsCommand,

  // ── Phase 2: read-only safe defaults ─────────────────────────────
  status: remote('status', 'Team health summary (running/offline + per-agent health)'),
  teams: remote('teams', 'List all teams in the manager DB'),
  team: remote('team', 'Show the active team (id, name, agent count)'),
  configs: remote('configs', 'List configs/*.yaml deployment files'),
  news: remote('news', 'List news items for an agent (`:news <agent>`)'),
  heartbeats: remote('heartbeats', 'List agents with heartbeat enabled'),
  output: remote('output', "List files in an agent's ./output dir (`:output <agent>`)"),
  artifact: remote('artifact', 'Read one artifact (`:artifact <agent> <path>`)'),
  meta: remote('meta', 'Show agent metadata (`:meta <agent>`)'),
  list: remote('list', 'Show all pending queries in the active team'),

  // ── Phase 2/3 hybrid: read-only by default, gated on mutator subcmds
  schedule: remote('schedule', 'Schedules: list/show (read), add/pause/resume/remove (gated)', {
    shouldConfirm: (args) => SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) =>
      SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? '')
        ? `schedule ${args.join(' ')}`
        : null,
  }),
  task: remote('task', 'Tasks: list/show (read), create/claim/done/remove (gated)', {
    shouldConfirm: (args) => TASK_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) =>
      TASK_MUTATORS.has(args[0]?.toLowerCase() ?? '') ? `task ${args.join(' ')}` : null,
  }),
  registry: remote('registry', 'Registry: bare show (read), `push` (gated bulk onchain register)', {
    shouldConfirm: (args) => (args[0]?.toLowerCase() ?? '') === 'push',
    confirmPreview: (args) =>
      (args[0]?.toLowerCase() ?? '') === 'push'
        ? 'registry push — register every unregistered agent onchain'
        : null,
  }),

  // ── Phase 3: powerful, always-gated entries ──────────────────────
  agent: remote('agent', 'Per-agent control: `:agent <name> <rebuild|start|stop|wallet provision|probe|logs>`', {
    shouldConfirm: (args) => AGENT_MUTATORS.has(args[1]?.toLowerCase() ?? ''),
    confirmPreview: (args) => {
      const sub = args[1]?.toLowerCase();
      const name = args[0] ?? '<agent>';
      if (!sub) return null;
      if (sub === 'wallet') return `provision OWS wallet for agent ${name}`;
      if (AGENT_MUTATORS.has(sub)) return `${sub} agent ${name}`;
      return null;
    },
  }),
  model: remote('model', 'Set agent model: `:model <agent> <model>`', {
    shouldConfirm: (args) => args.length >= 2,
    confirmPreview: (args) =>
      args.length >= 2 ? `set model ${args[1]} on agent ${args[0]}` : null,
  }),
  deploy: remote('deploy', 'Deploy a team config: `:deploy <config-name>`', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `deploy config: ${args.join(' ')}` : 'deploy (no args — will error)',
  }),
  sync: remote('sync', 'Sync team against YAML: `:sync <team>`', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `sync team: ${args.join(' ')}` : 'sync (no args — will error)',
  }),
  register: remote('register', 'Register one agent onchain: `:register <agent>`', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `register agent ${args[0]} onchain` : 'register (no args — will error)',
  }),
  heartbeat: remote('heartbeat', 'Heartbeat: bare status (read), `enable|disable <agent>` (gated)', {
    shouldConfirm: (args) => HEARTBEAT_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
    confirmPreview: (args) => {
      const sub = args[0]?.toLowerCase() ?? '';
      const name = args[1] ?? '<agent>';
      return HEARTBEAT_MUTATORS.has(sub) ? `${sub} heartbeat for agent ${name}` : null;
    },
  }),
};

export function lookupCommand(name: string): CommandSpec | null {
  return REGISTRY[name] ?? null;
}

export function knownCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

// Determine whether dispatch should be gated behind a Y/N prompt.
// Centralised here so the App-side handler doesn't have to know about
// per-spec predicates — it can call this with the parsed args.
export function commandRequiresConfirmation(spec: CommandSpec, args: string[]): boolean {
  return spec.shouldConfirm ? spec.shouldConfirm(args) : false;
}

// One-line preview text under the Y/N prompt, or null to fall back to
// the raw command line in the rendering layer.
export function commandConfirmPreview(spec: CommandSpec, args: string[]): string | null {
  return spec.confirmPreview ? spec.confirmPreview(args) : null;
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
// or null if no completion can be applied.
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
