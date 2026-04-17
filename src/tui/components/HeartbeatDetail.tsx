import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatInterval } from '../util/schedule.js';

interface HeartbeatDetailProps {
  agentName: string;
  workingDirectory: string | null;
  intervalSec: number;
  lastFireSec: number | null;
  nextFireSec: number;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
}

interface FileRead {
  lines: string[];
  missing: boolean;
  error: string | null;
  path: string | null;
}

export function HeartbeatDetail(props: HeartbeatDetailProps): React.ReactElement {
  const {
    agentName,
    workingDirectory,
    intervalSec,
    lastFireSec,
    nextFireSec,
    positionLabel,
    windowSize,
    scrollOffset,
    contentWidth,
  } = props;

  const file: FileRead = useMemo(
    () => readHeartbeatFile(workingDirectory, contentWidth),
    [workingDirectory, contentWidth],
  );

  const header = useMemo(
    () =>
      buildHeader({
        agentName,
        workingDirectory,
        intervalSec,
        lastFireSec,
        nextFireSec,
        filePath: file.path,
      }),
    [agentName, workingDirectory, intervalSec, lastFireSec, nextFireSec, file.path],
  );

  const body: string[] = file.missing
    ? ['(no HEARTBEAT.md configured for this agent)']
    : file.error
      ? [`(failed to read HEARTBEAT.md: ${file.error})`]
      : file.lines;

  const lines = [...header, '', '── HEARTBEAT.md ──', ...body];
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          heartbeat · {agentName}
        </Text>
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

function buildHeader(args: {
  agentName: string;
  workingDirectory: string | null;
  intervalSec: number;
  lastFireSec: number | null;
  nextFireSec: number;
  filePath: string | null;
}): string[] {
  const { agentName, workingDirectory, intervalSec, lastFireSec, nextFireSec, filePath } = args;
  const out: string[] = [];
  out.push(`agent:     ${agentName}`);
  out.push(`interval:  ${formatInterval(intervalSec)}`);
  out.push(`last fire: ${lastFireSec ? formatSec(lastFireSec) : '—'}`);
  out.push(`next fire: ${formatSec(nextFireSec)}`);
  out.push(`cwd:       ${workingDirectory ?? '—'}`);
  if (filePath) out.push(`file:      ${filePath}`);
  return out;
}

function readHeartbeatFile(workingDirectory: string | null, width: number): FileRead {
  if (!workingDirectory) {
    return { lines: [], missing: true, error: null, path: null };
  }
  const path = join(workingDirectory, 'HEARTBEAT.md');
  let exists = false;
  try {
    exists = statSync(path).isFile();
  } catch {
    return { lines: [], missing: true, error: null, path };
  }
  if (!exists) return { lines: [], missing: true, error: null, path };
  try {
    const raw = readFileSync(path, 'utf8');
    const out: string[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.replace(/\t/g, '    ');
      if (line.length === 0) {
        out.push('');
        continue;
      }
      out.push(...wrap(line, width));
    }
    return { lines: out, missing: false, error: null, path };
  } catch (err) {
    return {
      lines: [],
      missing: false,
      error: err instanceof Error ? err.message : String(err),
      path,
    };
  }
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

function formatSec(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
