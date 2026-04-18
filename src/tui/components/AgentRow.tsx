import React from 'react';
import { Text } from 'ink';
import type { Agent } from '../api/types.js';
import { padRight } from '../util/format.js';
import { statusColor, healthColor, healthDot } from '../util/colors.js';
import { formatMemory, memoryColor } from '../util/memory.js';

interface AgentRowProps {
  agent: Agent;
  selected: boolean;
  uptime: string;
  newsColor: string;
  memBytes: number | null;
}

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

const NEWS_GLYPH = '●';

function abbrevRuntime(rt?: string): string {
  if (!rt) return '—';
  if (rt === 'claude-code-cli') return 'claude-cli';
  if (rt === 'claude-agent-sdk') return 'claude-sdk';
  return rt;
}

function renderHealth(health: string): string {
  return `${healthDot(health)} ${health}`;
}

function AgentRowInner({ agent, selected, uptime, newsColor, memBytes }: AgentRowProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const name = padRight(agent.alias ?? agent.name, COLS.name);
  const port = padRight(agent.port ? String(agent.port) : '—', COLS.port);
  const runtime = padRight(abbrevRuntime(agent.metadata?.runtime), COLS.runtime);
  const status = padRight(agent.status, COLS.status);
  const health = padRight(renderHealth(agent.health), COLS.health);
  const hb = padRight(agent.metadata?.heartbeat ? '♥' : '-', COLS.hb);
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
      <Text color={newsColor}>{NEWS_GLYPH}</Text>
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
  const a = prev.agent;
  const b = next.agent;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.port === b.port &&
    a.status === b.status &&
    a.health === b.health &&
    a.metadata?.runtime === b.metadata?.runtime &&
    a.metadata?.heartbeat === b.metadata?.heartbeat
  );
});

export function AgentRowHeader(): React.ReactElement {
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
