import React from 'react';
import { Box, Text } from 'ink';
import { catalogEntriesByTier, type RiskTier } from '../commands/registry.js';

interface HelpViewProps {
  windowSize: number;
  scrollOffset: number;
}

type Row =
  | { kind: 'header'; tier: RiskTier; count: number }
  | { kind: 'cmd'; name: string; description: string; tier: RiskTier }
  | { kind: 'spacer' };

const TIER_LABEL: Record<RiskTier, string> = {
  safe: 'Safe',
  powerful: 'Powerful',
  destructive: 'Destructive',
};

const TIER_COLOR: Record<RiskTier, string> = {
  safe: 'green',
  powerful: 'yellow',
  destructive: 'red',
};

const TIER_ORDER: RiskTier[] = ['safe', 'powerful', 'destructive'];

function buildRows(): Row[] {
  const grouped = catalogEntriesByTier();
  const rows: Row[] = [];
  for (let i = 0; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i]!;
    const entries = grouped[tier];
    rows.push({ kind: 'header', tier, count: entries.length });
    for (const spec of entries) {
      rows.push({ kind: 'cmd', name: spec.name, description: spec.description, tier });
    }
    if (i < TIER_ORDER.length - 1) rows.push({ kind: 'spacer' });
  }
  return rows;
}

const NAME_COL_WIDTH = 16;

function renderRow(row: Row, key: string): React.ReactElement {
  if (row.kind === 'spacer') return <Text key={key}> </Text>;
  if (row.kind === 'header') {
    return (
      <Text key={key} bold color={TIER_COLOR[row.tier]}>
        {TIER_LABEL[row.tier]}
        <Text dimColor>{`  (${row.count})`}</Text>
      </Text>
    );
  }
  return (
    <Box key={key}>
      <Box width={NAME_COL_WIDTH}>
        <Text color={TIER_COLOR[row.tier]}>{`  :${row.name}`}</Text>
      </Box>
      <Text wrap="truncate-end">{row.description}</Text>
    </Box>
  );
}

export function HelpView(props: HelpViewProps): React.ReactElement {
  const rows = buildRows();
  const total = rows.length;
  const maxStart = Math.max(0, total - props.windowSize);
  const start = Math.min(Math.max(0, props.scrollOffset), maxStart);
  const visible = rows.slice(start, start + props.windowSize);
  const padCount = Math.max(0, props.windowSize - visible.length);
  const endLineNo = start + visible.length;

  // Count just the command rows (exclude headers + spacers) for the
  // header line. The spacers/headers are chrome, not content.
  const cmdCount = rows.filter((r) => r.kind === 'cmd').length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Help · {cmdCount} commands
        </Text>
        <Text dimColor>
          {total} lines · {total === 0 ? 0 : start + 1}–{endLineNo} · ↑↓/jk scroll · Esc / ? close
        </Text>
      </Box>
      <Text dimColor> </Text>
      {visible.map((row, i) => renderRow(row, `help-row-${start + i}`))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`help-pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
