import React from 'react';
import { Box, Text } from 'ink';
import type { Schedule } from '../api/types.js';
import { padRight, truncate } from '../util/format.js';
import { formatInterval } from '../util/schedule.js';

export interface HeartbeatRow {
  agent: string;
  schedule: Schedule;
  intervalSec: number;
  lastFireSec: number | null;
  nextFireSec: number;
}

interface HeartbeatsViewProps {
  rows: HeartbeatRow[];
  nowSec: number;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
}

const COLS = {
  marker: 2,
  agent: 18,
  interval: 10,
  last: 12,
  next: 14,
} as const;

export function HeartbeatsView(props: HeartbeatsViewProps): React.ReactElement {
  const { rows, nowSec, selectedIndex, windowStart, windowSize, loading, error } = props;

  const total = rows.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = rows.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Heartbeats ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
        </Text>
      </Box>
      <Header />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no active heartbeats in this view</Text>
      ) : (
        visible.map((row, i) => (
          <Row
            key={`${row.schedule.id}:${row.agent}`}
            row={row}
            nowSec={nowSec}
            selected={windowStart + i === selectedIndex}
          />
        ))
      )}
      {Array.from(
        {
          length: Math.max(
            0,
            windowSize -
              Math.max(visible.length, visible.length === 0 && !loading ? 1 : 0),
          ),
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
      {padRight('AGENT', COLS.agent)}
      {padRight('INTERVAL', COLS.interval)}
      {padRight('LAST HB', COLS.last)}
      {padRight('NEXT HB', COLS.next)}
    </Text>
  );
}

interface RowInnerProps {
  row: HeartbeatRow;
  nowSec: number;
  selected: boolean;
}

function RowInner({ row, nowSec, selected }: RowInnerProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const agent = padRight(truncate(row.agent, COLS.agent - 1), COLS.agent);
  const interval = padRight(formatInterval(row.intervalSec), COLS.interval);
  const last = padRight(
    row.lastFireSec == null ? 'new' : bucketedAgo(nowSec - row.lastFireSec),
    COLS.last,
  );
  const next = padRight(bucketedCountdown(row.nextFireSec - nowSec), COLS.next);
  const activeColor = row.schedule.active ? 'white' : 'gray';
  return (
    <Text inverse={selected}>
      {marker}
      <Text color={activeColor}>{agent}</Text>
      {interval}
      <Text dimColor>{last}</Text>
      <Text color="cyan">{next}</Text>
    </Text>
  );
}

const Row = React.memo(RowInner, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.nowSec !== next.nowSec) return false;
  const a = prev.row;
  const b = next.row;
  return (
    a.agent === b.agent &&
    a.intervalSec === b.intervalSec &&
    a.lastFireSec === b.lastFireSec &&
    a.nextFireSec === b.nextFireSec &&
    a.schedule.id === b.schedule.id &&
    a.schedule.active === b.schedule.active
  );
});

function bucketedAgo(deltaSec: number): string {
  if (deltaSec < 0) return 'new';
  if (deltaSec < 60) return '<1m ago';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function bucketedCountdown(deltaSec: number): string {
  if (deltaSec <= 0) return 'due';
  if (deltaSec < 60) return '<1m';
  if (deltaSec < 3600) return `in ${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `in ${Math.floor(deltaSec / 3600)}h`;
  return `in ${Math.floor(deltaSec / 86400)}d`;
}
