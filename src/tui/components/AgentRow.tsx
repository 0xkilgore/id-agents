import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../api/types.js';
import { humanizeUptime, humanizeAge, padRight } from '../util/format.js';
import { statusColor, healthColor, healthDot } from '../util/colors.js';

interface AgentRowProps {
  agent: Agent;
  selected: boolean;
  now: number;
}

const COLS = {
  marker: 2,
  name: 15,
  port: 5,
  runtime: 11,
  status: 8,
  health: 10,
  hb: 3,
  uptime: 10,
  lastSeen: 9,
} as const;

function abbrevRuntime(rt?: string): string {
  if (!rt) return '—';
  if (rt === 'claude-code-cli') return 'claude-cli';
  if (rt === 'claude-agent-sdk') return 'claude-sdk';
  return rt;
}

function renderHealth(health: string): string {
  return `${healthDot(health)} ${health}`;
}

export function AgentRow({ agent, selected, now }: AgentRowProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const name = padRight(agent.alias ?? agent.name, COLS.name);
  const port = padRight(agent.port ? String(agent.port) : '—', COLS.port);
  const runtime = padRight(abbrevRuntime(agent.metadata?.runtime), COLS.runtime);
  const status = padRight(agent.status, COLS.status);
  const health = padRight(renderHealth(agent.health), COLS.health);
  const hb = padRight(agent.metadata?.heartbeat ? '♥' : '-', COLS.hb);
  const uptime = padRight(humanizeUptime(agent.createdAt, now), COLS.uptime);
  const lastSeen = padRight(humanizeAge(agent.lastHealthCheck, now), COLS.lastSeen);

  return (
    <Text inverse={selected}>
      {marker}
      <Text bold={selected}>{name}</Text>
      {port}
      <Text dimColor>{runtime}</Text>
      <Text color={statusColor(agent.status)}>{status}</Text>
      <Text color={healthColor(agent.health)}>{health}</Text>
      {hb}
      {uptime}
      <Text dimColor>{lastSeen}</Text>
    </Text>
  );
}

export function AgentRowHeader(): React.ReactElement {
  return (
    <Text bold dimColor>
      {padRight('', COLS.marker)}
      {padRight('NAME', COLS.name)}
      {padRight('PORT', COLS.port)}
      {padRight('RUNTIME', COLS.runtime)}
      {padRight('STATUS', COLS.status)}
      {padRight('HEALTH', COLS.health)}
      {padRight('HB', COLS.hb)}
      {padRight('UPTIME', COLS.uptime)}
      {padRight('LAST SEEN', COLS.lastSeen)}
    </Text>
  );
}
