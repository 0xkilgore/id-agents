/**
 * AgentDetail — full-screen detail view for a focused remote agent.
 * Shows: customer_domain, public_endpoint_url, ows_wallet, idchain_domain,
 * last_seen, last_error, consecutive_failures, ssh_target.
 * Accessible in the agents view via → arrow when a remote agent is selected.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../api/types.js';
import { humanizeLastSeen } from '../util/format.js';
import { healthColor } from '../util/colors.js';

interface AgentDetailProps {
  agent: Agent | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
  nowMs: number;
}

function fieldRow(label: string, value: string | null | undefined, color?: string): string {
  const v = value ?? '(none)';
  const w = 22;
  const padded = label.padEnd(w);
  return `${padded}${v}`;
}

export function AgentDetail(props: AgentDetailProps): React.ReactElement {
  const { agent, positionLabel, windowSize, scrollOffset, contentWidth, nowMs } = props;

  if (!agent) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>agent · (none selected)</Text>
        <Text dimColor> </Text>
        <Text dimColor>(no agent selected — press ← to return)</Text>
        {Array.from({ length: Math.max(0, windowSize - 1) }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
      </Box>
    );
  }

  const isRemote = agent.deploymentShape === 'remote-endpoint' ||
    agent.metadata?.runtime === 'public-agent-remote';

  const lines: Array<{ label: string; value: string; color?: string }> = [];

  lines.push({ label: 'name', value: agent.alias ?? agent.name });
  lines.push({ label: 'runtime', value: agent.metadata?.runtime ?? '—' });
  lines.push({ label: 'health', value: agent.health, color: healthColor(agent.health) });
  lines.push({ label: 'status', value: agent.status });

  if (isRemote) {
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Remote Endpoint ---', value: '' });
    lines.push({ label: 'customer_domain', value: agent.customer_domain ?? '—' });
    lines.push({ label: 'public_endpoint_url', value: agent.public_endpoint_url ?? '—' });
    lines.push({ label: 'ows_wallet', value: (agent.metadata as Record<string, unknown> | undefined)?.ows_wallet as string ?? agent.ows_wallet ?? '—' });
    lines.push({ label: 'idchain_domain', value: (agent.metadata as Record<string, unknown> | undefined)?.idchain_domain as string ?? agent.idchain_domain ?? '—' });
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Probe Status ---', value: '' });
    const lastSeenStr = agent.last_seen
      ? `${humanizeLastSeen(agent.last_seen, nowMs)} (unix: ${agent.last_seen})`
      : '(never probed)';
    lines.push({ label: 'last_seen', value: lastSeenStr });
    lines.push({ label: 'last_error', value: agent.last_error ?? '(none)' });
    lines.push({ label: 'consecutive_failures', value: String(agent.consecutive_failures ?? 0) });
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Access ---', value: '' });
    lines.push({ label: 'ssh_target', value: agent.ssh_target ?? '(not configured)' });
  } else {
    lines.push({ label: 'port', value: agent.port ? String(agent.port) : '—' });
    lines.push({ label: 'workingDirectory', value: agent.workingDirectory ?? '—' });
  }

  const allLines = lines.map(({ label, value, color }) => ({ label, value, color }));
  const total = allLines.length;
  const clampedOffset = Math.min(scrollOffset, Math.max(0, total - windowSize));
  const visible = allLines.slice(clampedOffset, clampedOffset + windowSize);
  const hiddenAbove = clampedOffset;
  const hiddenBelow = total - clampedOffset - visible.length;
  const W = 22;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>agent · {agent.alias ?? agent.name}</Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.map((row, i) => {
        if (!row.label && !row.value) return <Text key={i}> </Text>;
        if (row.label.startsWith('---')) {
          return <Text key={i} bold dimColor>{row.label}</Text>;
        }
        return (
          <Text key={i}>
            <Text dimColor>{row.label.padEnd(W)}</Text>
            {row.color
              ? <Text color={row.color}>{row.value}</Text>
              : <Text>{row.value}</Text>
            }
          </Text>
        );
      })}
      {Array.from({ length: Math.max(0, windowSize - visible.length) }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}
