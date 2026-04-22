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
const PARTY_COL = 18;

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

  const total = items.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = items.slice(windowStart, windowEnd);

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
      const ageColor = newsAgeColor(item.timestamp, cooldownEpoch);
      const tColor = typeColor(item.type);
      const party = extractParty(item);
      const message = rewriteMessage(item.message ?? '', messageWidth);
      // Selection inverse wraps the marker and the right-hand content, but
      // NOT the age square — the square stays on a default background so
      // its color reads cleanly against the selection bar.
      lines.push(
        <Text key={`${item.timestamp}-${i}`}>
          <Text inverse={selected}>{selected ? '▶ ' : '  '}</Text>
          <Text color={ageColor}>■</Text>
          <Text inverse={selected}>
            {' '}
            <Text dimColor>{padRight(formatTime(item.timestamp), TIME_COL)}</Text>
            {' '}
            <Text color={tColor}>{padRight(item.type, TYPE_COL)}</Text>
            <Text dimColor>{padRight(party, PARTY_COL)}</Text>
            {' '}
            {message}
          </Text>
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

// Derive explicit From / To labels for each news item. The currently-viewed
// agent fills the implicit side: inbound items are TO the current agent,
// outbound items are FROM the current agent. Protocol-level 'remote' is
// rewritten to 'manager' to match the message body.
// Single-column party label: "from: <sender>" for inbound, "to: <recipient>"
// for outbound, blank for self-status events. 'remote' is rewritten to
// 'manager' for UI clarity; underlying data is unchanged.
function extractParty(item: NewsItem): string {
  const d = (item.data ?? {}) as Record<string, unknown>;
  const normalize = (v: unknown): string => {
    const raw = typeof v === 'string' ? v : '';
    return raw === 'remote' ? 'manager' : raw;
  };
  const from = normalize(d.from);
  const to = normalize(d.to);
  const type = item.type;
  if (type.startsWith('outbound')) {
    return to ? `  to: ${to}` : '';
  }
  if (type === 'query.received') {
    return `from: ${from || 'manager'}`;
  }
  if (type === 'reply' || type === 'news.received' || type === 'inbound.reply') {
    return from ? `from: ${from}` : '';
  }
  return '';
}

// The agent news log uses "remote" as the protocol-level name for the
// admin channel (the manager agent driving this TUI). Rewrite to "manager"
// client-side so the UI reads clearly; underlying data stays unchanged.
function rewriteMessage(msg: string, width: number): string {
  return truncate(oneLine(msg).replace(/\bremote\b/g, 'manager'), width);
}

function typeColor(type: string): string {
  if (type.startsWith('query.received')) return 'cyan';
  if (type.startsWith('query.completed')) return 'green';
  if (type.startsWith('query.failed')) return 'red';
  if (type.startsWith('outbound')) return 'yellow';
  if (type.startsWith('error')) return 'red';
  return 'white';
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

