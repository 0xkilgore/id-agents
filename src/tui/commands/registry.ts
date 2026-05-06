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

export type RiskTier = 'safe' | 'powerful' | 'destructive';

export interface CommandSpec {
  name: string;
  description: string;
  // Phase 5: declarative max-tier classification used by the help view
  // and any future surface that wants to colour commands by risk. The
  // tier reflects the WORST thing this catalog entry can do — for
  // hybrid entries like `schedule` (which has both `list` and `remove`
  // subcommands), the tier is the highest reachable level. The runtime
  // gate is still driven by `shouldConfirm`/`shouldRetype` predicates.
  tier: RiskTier;
  run: (ctx: CommandContext) => Promise<unknown>;
  // Returns true when the args trigger a destructive/mutating handler
  // and the user should see a Y/N prompt before dispatch. Absent or
  // returning false → run immediately (Phase 1/2 behavior).
  shouldConfirm?: (args: string[]) => boolean;
  // Phase 4 escalation. Returns true for high-risk commands that must
  // require the user to retype the exact command line before dispatch.
  // Retype takes precedence over Y/N when both predicates fire, so
  // there is no double-prompt — the user sees the retype prompt only.
  shouldRetype?: (args: string[]) => boolean;
  // One-line preview shown under either prompt to make the op
  // self-documenting (e.g., `delete agent foo`, `cancel running query
  // on agent foo`). Absent or returning null → renderer falls back to
  // the raw command line.
  confirmPreview?: (args: string[]) => string | null;
}

export type ConfirmationLevel = 'none' | 'yn' | 'retype';

// Build a CommandSpec that forwards to the manager's `/remote` endpoint
// using the action name plus whatever args the user typed after it.
function remote(
  name: string,
  description: string,
  tier: RiskTier,
  extras: Pick<CommandSpec, 'shouldConfirm' | 'shouldRetype' | 'confirmPreview'> = {},
): CommandSpec {
  return {
    name,
    description,
    tier,
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
  tier: 'safe',
  run: async ({ manager, signal }) => {
    const teams = await fetchTeams(manager, signal);
    const agents = await fetchAgentsAllTeams(manager, teams, signal);
    return { count: agents.length, agents };
  },
};

// `help` is a TUI-side action — invoking it via the bar opens the
// scrollable help view. The `run` body is intentionally inert; the
// App-level submit handler intercepts by name before calling run().
// Listed in the catalog so it shows up in tab completion and in the
// help view itself.
const helpCommand: CommandSpec = {
  name: 'help',
  description: 'Open the scrollable command help (also: ?)',
  tier: 'safe',
  run: async () => ({ tuiAction: 'help' }),
};

// ── Phase 3 predicates ─────────────────────────────────────────────
// These keep a single catalog entry per top-level token (`schedule`,
// `task`, `registry`, `agent`, `heartbeat`) and decide on the args
// alone whether to pop the confirmation prompt.

const SCHEDULE_MUTATORS = new Set(['add', 'pause', 'resume', 'remove']);
const TASK_MUTATORS = new Set(['create', 'claim', 'done', 'remove', 'delete']);
const AGENT_MUTATORS = new Set(['rebuild', 'start', 'stop', 'wallet']);
const HEARTBEAT_MUTATORS = new Set(['enable', 'disable']);
// Phase 4: subcommands that escalate from Y/N to retype.
const SCHEDULE_RETYPE = new Set(['remove']);
const TASK_RETYPE = new Set(['remove', 'delete']);

const REGISTRY: Record<string, CommandSpec> = {
  // ── Phase 1 ──────────────────────────────────────────────────────
  agents: agentsCommand,

  // ── Phase 5 TUI action ───────────────────────────────────────────
  help: helpCommand,

  // ── Phase 2: read-only safe defaults ─────────────────────────────
  status: remote('status', 'Team health summary (running/offline + per-agent health)', 'safe'),
  teams: remote('teams', 'List all teams in the manager DB', 'safe'),
  team: remote('team', 'Show the active team (id, name, agent count)', 'safe'),
  configs: remote('configs', 'List configs/*.yaml deployment files', 'safe'),
  news: remote('news', 'List news items for an agent (`:news <agent>`)', 'safe'),
  heartbeats: remote('heartbeats', 'List agents with heartbeat enabled', 'safe'),
  output: remote('output', "List files in an agent's ./output dir (`:output <agent>`)", 'safe'),
  artifact: remote('artifact', 'Read one artifact (`:artifact <agent> <path>`)', 'safe'),
  meta: remote('meta', 'Show agent metadata (`:meta <agent>`)', 'safe'),
  list: remote('list', 'Show all pending queries in the active team', 'safe'),

  // ── Phase 2/3/4 hybrids — tier reflects worst-case subcommand ────
  schedule: remote(
    'schedule',
    'Schedules: list/show (read), add/pause/resume (Y/N), remove (retype)',
    'destructive',
    {
      shouldConfirm: (args) => SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
      shouldRetype: (args) => SCHEDULE_RETYPE.has(args[0]?.toLowerCase() ?? ''),
      confirmPreview: (args) =>
        SCHEDULE_MUTATORS.has(args[0]?.toLowerCase() ?? '')
          ? `schedule ${args.join(' ')}`
          : null,
    },
  ),
  task: remote(
    'task',
    'Tasks: list/show (read), create/claim/done (Y/N), remove/delete (retype)',
    'destructive',
    {
      shouldConfirm: (args) => TASK_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
      shouldRetype: (args) => TASK_RETYPE.has(args[0]?.toLowerCase() ?? ''),
      confirmPreview: (args) =>
        TASK_MUTATORS.has(args[0]?.toLowerCase() ?? '') ? `task ${args.join(' ')}` : null,
    },
  ),
  registry: remote(
    'registry',
    'Registry: bare show (read), `push` (gated bulk onchain register)',
    'powerful',
    {
      shouldConfirm: (args) => (args[0]?.toLowerCase() ?? '') === 'push',
      confirmPreview: (args) =>
        (args[0]?.toLowerCase() ?? '') === 'push'
          ? 'registry push — register every unregistered agent onchain'
          : null,
    },
  ),

  // ── Phase 3: powerful, always-gated entries ──────────────────────
  agent: remote(
    'agent',
    'Per-agent control: `:agent <name> <rebuild|start|stop|wallet provision|probe|logs>`',
    'powerful',
    {
      shouldConfirm: (args) => AGENT_MUTATORS.has(args[1]?.toLowerCase() ?? ''),
      confirmPreview: (args) => {
        const sub = args[1]?.toLowerCase();
        const name = args[0] ?? '<agent>';
        if (!sub) return null;
        if (sub === 'wallet') return `provision OWS wallet for agent ${name}`;
        if (AGENT_MUTATORS.has(sub)) return `${sub} agent ${name}`;
        return null;
      },
    },
  ),
  model: remote('model', 'Set agent model: `:model <agent> <model>`', 'powerful', {
    shouldConfirm: (args) => args.length >= 2,
    confirmPreview: (args) =>
      args.length >= 2 ? `set model ${args[1]} on agent ${args[0]}` : null,
  }),
  deploy: remote('deploy', 'Deploy a team config: `:deploy <config-name>`', 'powerful', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `deploy config: ${args.join(' ')}` : 'deploy (no args — will error)',
  }),
  sync: remote('sync', 'Sync team against YAML: `:sync <team>`', 'powerful', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `sync team: ${args.join(' ')}` : 'sync (no args — will error)',
  }),
  register: remote('register', 'Register one agent onchain: `:register <agent>`', 'powerful', {
    shouldConfirm: () => true,
    confirmPreview: (args) =>
      args.length > 0 ? `register agent ${args[0]} onchain` : 'register (no args — will error)',
  }),
  heartbeat: remote(
    'heartbeat',
    'Heartbeat: bare status (read), `enable|disable <agent>` (gated)',
    'powerful',
    {
      shouldConfirm: (args) => HEARTBEAT_MUTATORS.has(args[0]?.toLowerCase() ?? ''),
      confirmPreview: (args) => {
        const sub = args[0]?.toLowerCase() ?? '';
        const name = args[1] ?? '<agent>';
        return HEARTBEAT_MUTATORS.has(sub) ? `${sub} heartbeat for agent ${name}` : null;
      },
    },
  ),

  // ── Phase 4: retype-tier (always-on exact-line confirmation) ─────
  delete: remote(
    'delete',
    'Delete agent(s): `:delete <name>` | `:delete *` | `:delete --team <name>`',
    'destructive',
    {
      shouldRetype: () => true,
      confirmPreview: (args) => {
        const first = args[0];
        if (!first) return 'delete (no args — will error)';
        if (first === '*') return 'DELETE ALL agents in the active team';
        if (first === '--team') {
          const t = args[1];
          return t ? `DELETE ALL agents in team ${t}` : 'delete --team (no team name)';
        }
        return `delete agent ${first}`;
      },
    },
  ),
  cancel: remote('cancel', "Cancel an agent's running query: `:cancel <agent>`", 'destructive', {
    shouldRetype: () => true,
    confirmPreview: (args) =>
      args[0] ? `cancel running query on agent ${args[0]}` : 'cancel (no args — will error)',
  }),
  clear: remote('clear', "Clear an agent's session: `:clear <agent>`", 'destructive', {
    shouldRetype: () => true,
    confirmPreview: (args) =>
      args[0] ? `clear session on agent ${args[0]}` : 'clear (no args — will error)',
  }),
  'sync-wallets': remote(
    'sync-wallets',
    'Bulk-sync multi-chain wallet addresses for all registered agents',
    'destructive',
    {
      shouldRetype: () => true,
      confirmPreview: () => 'sync wallet addresses for every registered agent in the team',
    },
  ),
};

export function lookupCommand(name: string): CommandSpec | null {
  return REGISTRY[name] ?? null;
}

export function knownCommandNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

// Phase 4: tri-state gate. Retype takes precedence over Y/N when both
// predicates fire so there is no double-prompt — the user only sees
// the higher-tier prompt. Centralised here so the App-side handler
// doesn't have to know per-spec predicates.
export function confirmationLevel(spec: CommandSpec, args: string[]): ConfirmationLevel {
  if (spec.shouldRetype && spec.shouldRetype(args)) return 'retype';
  if (spec.shouldConfirm && spec.shouldConfirm(args)) return 'yn';
  return 'none';
}

// One-line preview text under the Y/N prompt, or null to fall back to
// the raw command line in the rendering layer.
export function commandConfirmPreview(spec: CommandSpec, args: string[]): string | null {
  return spec.confirmPreview ? spec.confirmPreview(args) : null;
}

// Phase 5 helper: ordered iteration over all catalog entries grouped
// by tier, used by the help view. Tiers are returned in increasing
// risk order (safe, powerful, destructive); commands within each tier
// are sorted alphabetically. Sourcing from the catalog (rather than a
// hand-maintained list) is mandated by the Phase 5 brief.
export function catalogEntriesByTier(): Record<RiskTier, CommandSpec[]> {
  const out: Record<RiskTier, CommandSpec[]> = {
    safe: [],
    powerful: [],
    destructive: [],
  };
  for (const name of knownCommandNames()) {
    const spec = lookupCommand(name);
    if (!spec) continue;
    out[spec.tier].push(spec);
  }
  return out;
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
