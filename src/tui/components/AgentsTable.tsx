import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../api/types.js';
import { AgentRow, AgentRowHeader } from './AgentRow.js';

interface AgentsTableProps {
  agents: Agent[];
  uptimeById: ReadonlyMap<string, string>;
  newsColorById: ReadonlyMap<string, string>;
  memBytesById: ReadonlyMap<string, number | null>;
  totalMemoryLabel: string;
  totalMemoryColor: string;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
}

export function AgentsTable(props: AgentsTableProps): React.ReactElement {
  const {
    agents,
    uptimeById,
    newsColorById,
    memBytesById,
    totalMemoryLabel,
    totalMemoryColor,
    selectedIndex,
    windowStart,
    windowSize,
    loading,
    error,
  } = props;
  const total = agents.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = agents.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold>Agents ({total})</Text>
          <Text dimColor>{'  Total memory: '}</Text>
          <Text color={totalMemoryColor}>{totalMemoryLabel}</Text>
        </Box>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
        </Text>
      </Box>
      <AgentRowHeader />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no agents in this view</Text>
      ) : (
        visible.map((agent, i) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            uptime={uptimeById.get(agent.id) ?? '—'}
            newsColor={newsColorById.get(agent.id) ?? 'gray'}
            memBytes={memBytesById.get(agent.id) ?? null}
            selected={windowStart + i === selectedIndex}
          />
        ))
      )}
      {Array.from(
        { length: Math.max(0, windowSize - Math.max(visible.length, visible.length === 0 && !loading ? 1 : 0)) },
        (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ),
      )}
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}
