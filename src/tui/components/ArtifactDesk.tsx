import React from 'react';
import { Box, Text } from 'ink';
import type { ArtifactDeskResponse, ArtifactDeskRow } from '../api/types.js';
import { padRight, truncate } from '../util/format.js';

interface ArtifactDeskProps {
  response: ArtifactDeskResponse | null;
  loading: boolean;
  error: Error | null;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
}

const COLS = {
  marker: 2,
  title: 34,
  status: 12,
  agent: 16,
  source: 14,
} as const;

export function ArtifactDesk(props: ArtifactDeskProps): React.ReactElement {
  const { response, loading, error, selectedIndex, windowStart, windowSize } = props;
  const rows = response?.rows ?? [];
  const total = rows.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = rows.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;
  const health = response?.health;
  const suppressed = response?.recent_flood?.suppressed_from_primary_count ?? 0;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Artifacts ({total})</Text>
        <Text color={health?.ok === false ? 'yellow' : 'gray'}>
          {loading && total === 0 ? 'loading...' : null}
          {error ? `error: ${error.message}` : null}
          {!loading && !error && health?.ok === false ? `${health.event_count} visibility issue${health.event_count === 1 ? '' : 's'}` : null}
          {!loading && !error && health?.ok !== false && suppressed > 0 ? `${suppressed} grouped` : null}
        </Text>
      </Box>
      <Text dimColor>
        surfaced artifact desk · missing bodies stay selectable · press r to refresh
      </Text>
      <Header />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 ? (
        <Text dimColor>
          {loading ? 'loading artifacts...' : error ? 'artifact desk unavailable' : 'no artifacts surfaced'}
        </Text>
      ) : (
        visible.map((row, i) => (
          <ArtifactDeskItem
            key={`${row.id}:${windowStart + i}`}
            row={row}
            selected={windowStart + i === selectedIndex}
          />
        ))
      )}
      {Array.from(
        {
          length: Math.max(0, windowSize - Math.max(visible.length, visible.length === 0 ? 1 : 0)),
        },
        (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ),
      )}
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Header(): React.ReactElement {
  return (
    <Text bold dimColor>
      {padRight('', COLS.marker)}
      {padRight('TITLE', COLS.title)}
      {padRight('STATUS', COLS.status)}
      {padRight('AGENT', COLS.agent)}
      {padRight('SOURCE', COLS.source)}
    </Text>
  );
}

function ArtifactDeskItem(props: { row: ArtifactDeskRow; selected: boolean }): React.ReactElement {
  const { row, selected } = props;
  const missing = row.visibility_proof?.body_renderable === false || row.delivery?.body_available === false;
  const status = missing ? visibleStatus(row.status, 'missing body') : visibleStatus(row.status);
  const source = row.source_kind ?? row.visibility_proof?.discovered_by ?? 'artifact';
  return (
    <Text inverse={selected}>
      {selected ? '▶ ' : '  '}
      {padRight(truncate(oneLine(row.title || row.id), COLS.title - 1), COLS.title)}
      <Text color={statusColor(status)}>{padRight(status, COLS.status)}</Text>
      {padRight(truncate(row.agent_name ?? 'unknown', COLS.agent - 1), COLS.agent)}
      {padRight(truncate(source, COLS.source - 1), COLS.source)}
    </Text>
  );
}

function visibleStatus(status: string, fallback?: string): string {
  const clean = status.replace(/_/g, ' ').trim();
  return fallback ?? (clean || 'unknown');
}

function statusColor(status: string): string {
  if (status.includes('missing') || status.includes('error')) return 'yellow';
  if (status.includes('approved') || status.includes('shipped')) return 'green';
  if (status.includes('rejected')) return 'red';
  if (status.includes('comment')) return 'cyan';
  return 'white';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
