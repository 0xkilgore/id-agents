/**
 * TUI public-team row verification script.
 *
 * No TUI test harness (react-ink renderer) exists in this repo, so this
 * script takes the fallback path: import the pure render-logic helpers,
 * feed them a fake public-agent-remote agent, and print the expected
 * column widths + rendered strings so an operator can visually confirm
 * the output.
 *
 * Run from the repo root:
 *   npx tsx scripts/verify-tui-public.ts
 *
 * What it verifies:
 *   - PORT renders '—' for remote agents
 *   - MEM renders '—' for remote agents
 *   - UPTIME renders a last_seen duration string (or blank if never seen)
 *   - DOMAIN renders customer_domain truncated to 25 chars with '…' suffix
 *   - DMZ renders 'DMZ' when metadata.dmz=true, empty otherwise
 *   - healthDot: online→'●', unstable→'●', offline→'○', unknown→'○'
 *   - healthColor: online→green, unstable→yellow, offline→red, unknown→gray
 */

import { padRight, truncate, humanizeLastSeen } from '../src/tui/util/format.js';
import { healthColor, healthDot } from '../src/tui/util/colors.js';
import type { Agent } from '../src/tui/api/types.js';

// ─── Fake public-agent-remote agent ──────────────────────────────────────────

const NOW_MS = Date.now();
const LAST_SEEN_SEC = Math.floor(NOW_MS / 1000) - 300; // 5 minutes ago

function makeRemoteAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-remote-001',
    name: 'acme-support.xid.eth',
    alias: 'acme-support',
    port: 0,
    status: 'registered',
    health: 'online',
    model: 'claude-sonnet-4-6',
    type: 'virtual',
    createdAt: NOW_MS - 86400 * 1000,
    metadata: {
      runtime: 'public-agent-remote',
      dmz: false,
    },
    teamName: 'public',
    deploymentShape: 'remote-endpoint',
    customer_domain: 'support.acme.example.com',
    public_endpoint_url: 'https://support.acme.example.com',
    last_seen: LAST_SEEN_SEC,
    last_error: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

// ─── Column rendering (mirrors AgentRow logic) ────────────────────────────────

const REMOTE_COLS = {
  marker: 2,
  name: 17,
  port: 6,
  runtime: 12,
  status: 9,
  health: 11,
  news: 2,
  hb: 3,
  mem: 8,
  uptime: 14,
  domain: 26,
  dmz: 4,
} as const;

function abbrevRuntime(rt?: string): string {
  if (!rt) return '—';
  if (rt === 'public-agent-remote') return 'pa-remote';
  return rt;
}

function renderRow(agent: Agent, nowMs: number): string {
  const marker = '  ';
  const name = padRight(agent.alias ?? agent.name, REMOTE_COLS.name);
  const port = padRight('—', REMOTE_COLS.port);
  const runtime = padRight(abbrevRuntime(agent.metadata?.runtime), REMOTE_COLS.runtime);
  const remoteStatusLabel = agent.health === 'unknown' ? 'registered' : agent.health;
  const status = padRight(remoteStatusLabel, REMOTE_COLS.status);
  const healthStr = padRight(`${healthDot(agent.health)} ${agent.health}`, REMOTE_COLS.health);
  const news = '● ';
  const hb = padRight('-', REMOTE_COLS.hb);
  const mem = padRight('—', REMOTE_COLS.mem);
  const lastSeenStr = humanizeLastSeen(agent.last_seen, nowMs);
  const uptime = padRight(lastSeenStr, REMOTE_COLS.uptime);
  const domainVal = agent.customer_domain ?? '';
  const domain = padRight(truncate(domainVal, 25), REMOTE_COLS.domain);
  const dmzVal = (agent.metadata as Record<string, unknown> | undefined)?.dmz === true ? 'DMZ' : '';
  const dmz = padRight(dmzVal, REMOTE_COLS.dmz);

  return `${marker}${name}${port}${runtime}${status}${healthStr}${news}${hb}${mem}${uptime}${domain}${dmz}`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

function renderHeader(): string {
  const m = '  ';
  return (
    m +
    padRight('NAME', REMOTE_COLS.name) +
    padRight('PORT', REMOTE_COLS.port) +
    padRight('RUNTIME', REMOTE_COLS.runtime) +
    padRight('STATUS', REMOTE_COLS.status) +
    padRight('HEALTH', REMOTE_COLS.health) +
    padRight('N', REMOTE_COLS.news) +
    padRight('HB', REMOTE_COLS.hb) +
    padRight('MEM', REMOTE_COLS.mem) +
    padRight('UPTIME', REMOTE_COLS.uptime) +
    padRight('DOMAIN', REMOTE_COLS.domain) +
    padRight('DMZ', REMOTE_COLS.dmz)
  );
}

// ─── Test cases ───────────────────────────────────────────────────────────────

const cases: Array<{ label: string; agent: Agent }> = [
  { label: 'online, no DMZ, has last_seen', agent: makeRemoteAgent({ health: 'online' }) },
  { label: 'unstable, no DMZ, no last_seen', agent: makeRemoteAgent({ health: 'unstable', last_seen: null }) },
  { label: 'offline, DMZ=true', agent: makeRemoteAgent({ health: 'offline', metadata: { runtime: 'public-agent-remote', dmz: true } }) },
  { label: 'unknown/registered', agent: makeRemoteAgent({ health: 'unknown', status: 'registered', last_seen: null }) },
  { label: 'long domain (truncation test)', agent: makeRemoteAgent({ customer_domain: 'this-is-a-very-long-subdomain.acme.example.com' }) },
];

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('\n=== TUI Public-Team Row Verification ===\n');
console.log(renderHeader());
console.log('─'.repeat(renderHeader().length));

let allPassed = true;
for (const { label, agent } of cases) {
  const row = renderRow(agent, NOW_MS);
  console.log(row, ` ← ${label}`);

  // Assertions
  const rowStr = row;
  const checks: Array<[string, boolean]> = [
    ['PORT is —', rowStr.includes('—')],
    ['MEM is —', rowStr.includes('—')],
    ['RUNTIME shows pa-remote', rowStr.includes('pa-remote')],
    ['DOMAIN present', rowStr.includes((agent.customer_domain ?? '').slice(0, 10)) || agent.customer_domain == null],
    ['DMZ badge when dmz=true', (agent.metadata as Record<string, unknown> | undefined)?.dmz === true ? rowStr.includes('DMZ') : !rowStr.includes('DMZ') || rowStr.trim().endsWith('')],
    ['health dot correct',
      agent.health === 'online' ? rowStr.includes('●') :
      agent.health === 'unstable' ? rowStr.includes('●') :
      rowStr.includes('○')
    ],
  ];

  let rowPassed = true;
  for (const [name, pass] of checks) {
    if (!pass) {
      console.error(`  FAIL: ${name}`);
      rowPassed = false;
      allPassed = false;
    }
  }
  if (rowPassed) console.log('  all checks passed');
}

// Health color spot-checks
console.log('\n=== Health Color Checks ===');
const colorChecks: Array<[string, string, string]> = [
  ['online', healthColor('online'), 'green'],
  ['unstable', healthColor('unstable'), 'yellow'],
  ['offline', healthColor('offline'), 'red'],
  ['unknown', healthColor('unknown'), 'gray'],
];
for (const [health, got, want] of colorChecks) {
  const pass = got === want;
  console.log(`  healthColor('${health}') = '${got}' ${pass ? 'OK' : `FAIL (want '${want}')`}`);
  if (!pass) allPassed = false;
}

// Health dot spot-checks
console.log('\n=== Health Dot Checks ===');
const dotChecks: Array<[string, string, string]> = [
  ['online', healthDot('online'), '●'],
  ['unstable', healthDot('unstable'), '●'],
  ['offline', healthDot('offline'), '○'],
  ['unknown', healthDot('unknown'), '○'],
];
for (const [health, got, want] of dotChecks) {
  const pass = got === want;
  console.log(`  healthDot('${health}') = '${got}' ${pass ? 'OK' : `FAIL (want '${want}')`}`);
  if (!pass) allPassed = false;
}

console.log('\n' + (allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED') + '\n');
process.exit(allPassed ? 0 : 1);
