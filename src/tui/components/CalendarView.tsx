import React from 'react';
import { Box, Text } from 'ink';
import type { Schedule } from '../api/types.js';
import { padRight, truncate } from '../util/format.js';
import { cadenceLabel, formatNextFire, nextFireSec } from '../util/schedule.js';

interface CalendarRow {
  schedule: Schedule;
  nextFire: number | null;
}

interface CalendarViewProps {
  schedules: Schedule[];
  nowSec: number;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
}

const COLS = {
  marker: 2,
  time: 11,
  agent: 14,
  title: 27,
  cadence: 14,
} as const;

export function CalendarView(props: CalendarViewProps): React.ReactElement {
  const { schedules, nowSec, selectedIndex, windowStart, windowSize, loading, error } = props;

  const rows: CalendarRow[] = React.useMemo(() => {
    const out: CalendarRow[] = schedules.map((s) => ({
      schedule: s,
      nextFire: nextFireSec(s, nowSec),
    }));
    out.sort((a, b) => {
      const av = a.nextFire ?? Number.POSITIVE_INFINITY;
      const bv = b.nextFire ?? Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      return a.schedule.id.localeCompare(b.schedule.id);
    });
    return out;
  }, [schedules, nowSec]);

  const total = rows.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = rows.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Calendar ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
        </Text>
      </Box>
      <Header />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no scheduled items in this view</Text>
      ) : (
        visible.map((row, i) => (
          <Row
            key={row.schedule.id}
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
      {padRight('TIME', COLS.time)}
      {padRight('AGENT', COLS.agent)}
      {padRight('TITLE', COLS.title)}
      {padRight('CADENCE', COLS.cadence)}
    </Text>
  );
}

interface RowInnerProps {
  row: CalendarRow;
  nowSec: number;
  selected: boolean;
}

function RowInner({ row, nowSec, selected }: RowInnerProps): React.ReactElement {
  const { schedule, nextFire } = row;
  const marker = selected ? '▶ ' : '  ';
  const timeCell =
    nextFire != null ? padRight(formatNextFire(nextFire, nowSec), COLS.time) : padRight('—', COLS.time);
  const agent = padRight(truncate(schedule.targets.join(','), COLS.agent - 1), COLS.agent);
  const title = padRight(schedule.title, COLS.title);
  const cadence = padRight(cadenceLabel(schedule), COLS.cadence);
  const kindColor = schedule.kind === 'heartbeat' ? 'cyan' : 'magenta';
  return (
    <Text inverse={selected}>
      {marker}
      <Text color={schedule.active ? 'white' : 'gray'}>{timeCell}</Text>
      {agent}
      {title}
      <Text color={kindColor}>{cadence}</Text>
    </Text>
  );
}

const Row = React.memo(RowInner, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.nowSec !== next.nowSec) return false;
  const a = prev.row;
  const b = next.row;
  return (
    a.nextFire === b.nextFire &&
    a.schedule.id === b.schedule.id &&
    a.schedule.title === b.schedule.title &&
    a.schedule.active === b.schedule.active &&
    a.schedule.intervalSeconds === b.schedule.intervalSeconds &&
    a.schedule.targets.join(',') === b.schedule.targets.join(',')
  );
});
