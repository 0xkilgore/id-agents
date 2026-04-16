import React from 'react';
import { Box, Text } from 'ink';
import type { NewsItem } from '../api/types.js';
import { padRight, truncate } from '../util/format.js';
import { newsAgeColor } from '../util/colors.js';

interface NewsViewProps {
  agentName: string | null;
  items: NewsItem[];
  loading: boolean;
  error: Error | null;
  windowStart: number;
  windowSize: number;
  selectedIndex: number;
  messageWidth: number;
  cooldownEpoch: number;
}

const TIME_COL = 8;
const TYPE_COL = 17;

export function NewsView(props: NewsViewProps): React.ReactElement {
  const {
    agentName,
    items,
    loading,
    error,
    windowStart,
    windowSize,
    selectedIndex,
    messageWidth,
    cooldownEpoch,
  } = props;

  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const total = sorted.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = sorted.slice(windowStart, windowEnd);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>news · {agentName ?? '(no agent)'} </Text>
        <Text dimColor>{total > 0 ? `${total} items` : ''}</Text>
      </Box>
      <Text dimColor>{windowStart > 0 ? `↑ ${windowStart} more above` : ' '}</Text>
      <Body
        agentName={agentName}
        items={visible}
        total={total}
        loading={loading}
        error={error}
        windowStart={windowStart}
        selectedIndex={selectedIndex}
        messageWidth={messageWidth}
        windowSize={windowSize}
        cooldownEpoch={cooldownEpoch}
      />
      <Text dimColor>
        {total - windowEnd > 0 ? `↓ ${total - windowEnd} more below` : ' '}
      </Text>
    </Box>
  );
}

interface BodyProps {
  agentName: string | null;
  items: NewsItem[];
  total: number;
  loading: boolean;
  error: Error | null;
  windowStart: number;
  selectedIndex: number;
  messageWidth: number;
  windowSize: number;
  cooldownEpoch: number;
}

function Body(props: BodyProps): React.ReactElement {
  const {
    agentName,
    items,
    total,
    loading,
    error,
    windowStart,
    selectedIndex,
    messageWidth,
    windowSize,
    cooldownEpoch,
  } = props;

  const lines: React.ReactElement[] = [];

  if (!agentName) {
    lines.push(
      <Text key="msg" dimColor>
        No agent selected
      </Text>,
    );
  } else if (error) {
    lines.push(
      <Text key="msg" color="red">
        Failed to load news: {error.message}
      </Text>,
    );
  } else if (total === 0 && loading) {
    lines.push(
      <Text key="msg" dimColor>
        loading…
      </Text>,
    );
  } else if (total === 0) {
    lines.push(
      <Text key="msg" dimColor>
        No activity
      </Text>,
    );
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const selected = windowStart + i === selectedIndex;
      const dotColor = newsAgeColor(item.timestamp, cooldownEpoch);
      lines.push(
        <Text key={`${item.timestamp}-${i}`} inverse={selected}>
          {selected ? '▶ ' : '  '}
          <Text color={dotColor}>●</Text>
          {' '}
          {padRight(formatTime(item.timestamp), TIME_COL)}{' '}
          {padRight(item.type, TYPE_COL)}
          {truncate(oneLine(item.message ?? ''), messageWidth)}
        </Text>,
      );
    }
  }

  while (lines.length < windowSize) {
    lines.push(
      <Text key={`pad-${lines.length}`}> </Text>,
    );
  }

  return <>{lines}</>;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

