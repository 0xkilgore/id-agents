import React from 'react';
import { Text } from 'ink';
import type { Agent } from '../api/types.js';
import { padRight, truncate, humanizeLastSeen } from '../util/format.js';
import { statusColor, healthColor, healthDot } from '../util/colors.js';
import { formatMemory, memoryColor } from '../util/memory.js';

interface AgentRowProps {
  agent: Agent;
  selected: boolean;
  uptime: string;
  newsColor: string;
  memBytes: number | null;
  nowMs: number;
}

// Column widths for local agents
const COLS = {
  marker: 2,
  name: 17,
  port: 6,
  runtime: 12,
  status: 9,
  health: 11,
  news: 2,
  hb: 3,
  mem: 8,
  uptime: 6,
} as const;

// Column widths for remote agents — port/mem render '—', uptime shows last_seen,
// two extra columns: DOMAIN and DMZ appended at the end.
const REMOTE_COLS = {
  marker: 2,
  name: 17,
  port: 6,    // renders '—' but keeps same width
  runtime: 12,
  status: 9,
  health: 11,
  news: 2,
  hb: 3,
  mem: 8,     // renders '—' but keeps same width
  uptime: 14, // wider to show "Xm ago"
  domain: 18, // customer_domain truncated to 17 chars + overflow '…'
  dmz: 3,     // DMZ badge (3 chars) or empty
} as const;

const NEWS_GLYPH = '●';

function abbrevRuntime(rt?: string): string {
  if (!rt) return '—';
  if (rt === 'claude-code-cli') return 'claude-cli';
  if (rt === 'claude-agent-sdk') return 'claude-sdk';
  if (rt === 'public-agent-remote') return 'juno';
  return rt;
}

function renderHealth(health: string): string {
  return `${healthDot(health)} ${health}`;
}

function isRemoteAgent(agent: Agent): boolean {
  return agent.deploymentShape === 'remote-endpoint' ||
    agent.metadata?.runtime === 'public-agent-remote';
}

function AgentRowInner({ agent, selected, uptime, newsColor, memBytes, nowMs }: AgentRowProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const name = padRight(agent.alias ?? agent.name, COLS.name);
  const runtime = padRight(abbrevRuntime(agent.metadata?.runtime), COLS.runtime);
  const health = padRight(renderHealth(agent.health), COLS.health);
  const hb = padRight(agent.metadata?.heartbeat ? '♥' : '-', COLS.hb);
  const newsGlyph = NEWS_GLYPH;

  if (isRemoteAgent(agent)) {
    // Remote agent row: PORT=—, MEM=—, UPTIME=last_seen, + DOMAIN + DMZ
    const portCell = padRight('—', REMOTE_COLS.port);
    const memCell = padRight('—', REMOTE_COLS.mem);
    const lastSeenStr = humanizeLastSeen(agent.last_seen, nowMs);
    const uptimeCell = padRight(lastSeenStr, REMOTE_COLS.uptime);
    const domainVal = agent.customer_domain ?? '';
    const domainCell = padRight(truncate(domainVal, 17), REMOTE_COLS.domain);
    const dmzVal = (agent.metadata as Record<string, unknown> | undefined)?.dmz === true ? 'DMZ' : '';
    const dmzCell = padRight(dmzVal, REMOTE_COLS.dmz);

    // STATUS column: for remote agents derive from health
    const remoteStatusLabel = agent.health === 'unknown' ? 'registered' : agent.health;
    const remoteStatus = padRight(remoteStatusLabel, COLS.status);

    return (
      <Text inverse={selected}>
        {marker}
        <Text bold={selected}>{name}</Text>
        <Text dimColor>{portCell}</Text>
        <Text dimColor>{runtime}</Text>
        <Text color={healthColor(agent.health)}>{remoteStatus}</Text>
        <Text color={healthColor(agent.health)}>{health}</Text>
        <Text color={newsColor}>{newsGlyph}</Text>
        {' '}
        {hb}
        <Text dimColor>{memCell}</Text>
        <Text dimColor>{uptimeCell}</Text>
        <Text dimColor>{domainCell}</Text>
        {dmzVal ? <Text color="yellow">{dmzCell}</Text> : <Text>{dmzCell}</Text>}
      </Text>
    );
  }

  // Local agent row
  const port = padRight(agent.port ? String(agent.port) : '—', COLS.port);
  const status = padRight(agent.status, COLS.status);
  const memCell = padRight(formatMemory(memBytes), COLS.mem);
  const uptimeCell = padRight(uptime, COLS.uptime);

  return (
    <Text inverse={selected}>
      {marker}
      <Text bold={selected}>{name}</Text>
      {port}
      <Text dimColor>{runtime}</Text>
      <Text color={statusColor(agent.status)}>{status}</Text>
      <Text color={healthColor(agent.health)}>{health}</Text>
      <Text color={newsColor}>{newsGlyph}</Text>
      {' '}
      {hb}
      <Text color={memoryColor(memBytes)}>{memCell}</Text>
      {uptimeCell}
    </Text>
  );
}

export const AgentRow = React.memo(AgentRowInner, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.uptime !== next.uptime) return false;
  if (prev.newsColor !== next.newsColor) return false;
  if (prev.memBytes !== next.memBytes) return false;
  if (prev.nowMs !== next.nowMs) return false;
  const a = prev.agent;
  const b = next.agent;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.port === b.port &&
    a.status === b.status &&
    a.health === b.health &&
    a.metadata?.runtime === b.metadata?.runtime &&
    a.metadata?.heartbeat === b.metadata?.heartbeat &&
    (a.metadata as Record<string, unknown> | undefined)?.dmz ===
      (b.metadata as Record<string, unknown> | undefined)?.dmz &&
    a.last_seen === b.last_seen &&
    a.customer_domain === b.customer_domain
  );
});

export function AgentRowHeader(props: { hasRemote?: boolean }): React.ReactElement {
  if (props.hasRemote) {
    return (
      <Text bold dimColor>
        {padRight('', REMOTE_COLS.marker)}
        {padRight('NAME', REMOTE_COLS.name)}
        {padRight('PORT', REMOTE_COLS.port)}
        {padRight('RUNTIME', REMOTE_COLS.runtime)}
        {padRight('STATUS', COLS.status)}
        {padRight('HEALTH', COLS.health)}
        {padRight('N', COLS.news)}
        {padRight('HB', COLS.hb)}
        {padRight('MEM', REMOTE_COLS.mem)}
        {padRight('UPTIME', REMOTE_COLS.uptime)}
        {padRight('DOMAIN', REMOTE_COLS.domain)}
        {padRight('DMZ', REMOTE_COLS.dmz)}
      </Text>
    );
  }
  return (
    <Text bold dimColor>
      {padRight('', COLS.marker)}
      {padRight('NAME', COLS.name)}
      {padRight('PORT', COLS.port)}
      {padRight('RUNTIME', COLS.runtime)}
      {padRight('STATUS', COLS.status)}
      {padRight('HEALTH', COLS.health)}
      {padRight('N', COLS.news)}
      {padRight('HB', COLS.hb)}
      {padRight('MEM', COLS.mem)}
      {padRight('UPTIME', COLS.uptime)}
    </Text>
  );
}
