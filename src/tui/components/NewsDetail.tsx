import React from 'react';
import { Box, Text } from 'ink';
import type { NewsItem } from '../api/types.js';

interface NewsDetailProps {
  agentName: string | null;
  item: NewsItem | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
}

export function NewsDetail(props: NewsDetailProps): React.ReactElement {
  const { agentName, item, positionLabel, windowSize, scrollOffset, contentWidth } = props;

  const lines = item
    ? buildBodyLines(item, contentWidth)
    : ['(no news item selected)'];
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>news · {agentName ?? '(no agent)'} </Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={windowSize} />
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Body(props: { visible: string[]; windowSize: number }): React.ReactElement {
  const { visible, windowSize } = props;
  const padCount = Math.max(0, windowSize - visible.length);
  return (
    <>
      {visible.map((line, i) => (
        <Text key={`line-${i}`}>{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </>
  );
}

function buildBodyLines(item: NewsItem, width: number): string[] {
  const out: string[] = [];
  const header = `${formatTime(item.timestamp)}   ${item.type}`;
  out.push(header);
  out.push('');
  out.push('── message ──');
  const message = rewriteRemote(oneLine(item.message ?? '(no message)'));
  out.push(...wrap(message, width));
  if (item.data !== undefined && item.data !== null) {
    out.push('');
    out.push('── data ──');
    let pretty: string;
    try {
      pretty = JSON.stringify(item.data, null, 2);
    } catch {
      pretty = String(item.data);
    }
    for (const line of pretty.split('\n')) {
      out.push(...wrap(line, width));
    }
  }
  return out;
}

function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let remaining = s;
  while (remaining.length > width) {
    out.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  out.push(remaining);
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function rewriteRemote(s: string): string {
  return s.replace(/\bremote\b/g, 'manager');
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
