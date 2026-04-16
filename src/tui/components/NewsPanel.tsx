import React from 'react';
import { Box, Text } from 'ink';
import type { NewsItem } from '../api/types.js';
import { padRight, truncate } from '../util/format.js';

interface NewsPanelProps {
  agentName: string | null;
  items: NewsItem[] | null;
  loading: boolean;
  error: Error | null;
  maxItems: number;
  messageWidth: number;
}

const TIME_COL = 8;
const TYPE_COL = 17;

export function NewsPanel(props: NewsPanelProps): React.ReactElement {
  const { agentName, items, loading, error, maxItems, messageWidth } = props;
  const title = agentName ? `News · ${agentName}` : 'News';

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      <Body
        agentName={agentName}
        items={items}
        loading={loading}
        error={error}
        maxItems={maxItems}
        messageWidth={messageWidth}
      />
    </Box>
  );
}

function Body(props: NewsPanelProps): React.ReactElement {
  const { agentName, items, loading, error, maxItems, messageWidth } = props;

  if (!agentName) return <Text dimColor>No agent selected</Text>;
  if (error) return <Text color="red">Failed to load news: {error.message}</Text>;
  if (items === null) return <Text dimColor>{loading ? 'loading…' : ' '}</Text>;
  if (items.length === 0) return <Text dimColor>No activity</Text>;

  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxItems);

  return (
    <>
      {sorted.map((item, i) => (
        <Text key={`${item.timestamp}-${i}`}>
          <Text dimColor>{padRight(formatTime(item.timestamp), TIME_COL)}</Text>
          <Text> </Text>
          <Text color={typeColor(item.type)}>{padRight(item.type, TYPE_COL)}</Text>
          <Text>{truncate(oneLine(item.message ?? ''), messageWidth)}</Text>
        </Text>
      ))}
    </>
  );
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

function typeColor(type: string): string {
  if (type.startsWith('query.received')) return 'cyan';
  if (type.startsWith('query.completed')) return 'green';
  if (type.startsWith('query.failed')) return 'red';
  if (type.startsWith('outbound')) return 'yellow';
  if (type.startsWith('error')) return 'red';
  return 'white';
}
