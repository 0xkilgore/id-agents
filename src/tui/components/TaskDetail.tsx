import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '../api/types.js';
import { taskStatusColor } from '../util/colors.js';
import type { TaskSurfaceState } from '../tasks/task-surface-state.js';

interface TaskDetailProps {
  task: Task | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
  surface: TaskSurfaceState;
}

export function TaskDetail(props: TaskDetailProps): React.ReactElement {
  const { task, positionLabel, windowSize, scrollOffset, contentWidth, surface } = props;

  const bodyWindowSize = Math.max(0, windowSize - 1);
  const lines = task ? buildBodyLines(task, contentWidth) : ['(no task selected)'];
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - bodyWindowSize));
  const end = Math.min(total, start + bodyWindowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;
  const sColor = task ? taskStatusColor(task.status) : 'white';

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          task · {task?.name ?? '(none)'}
          {task ? <Text dimColor>  {task.shortId ?? shortFromUuid(task.uuid)}</Text> : null}
          {task ? <>{'  '}<Text color={sColor}>{task.status}</Text></> : null}
        </Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text color={colorForTone(surface.tone)}>
        {surface.label}
        {surface.detail ? <Text dimColor> · {surface.detail}</Text> : null}
        <Text dimColor> · press r to refresh</Text>
      </Text>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={bodyWindowSize} />
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

function buildBodyLines(task: Task, width: number): string[] {
  const out: string[] = [];
  out.push(`title:    ${oneLine(task.title)}`);
  out.push(`owner:    ${task.ownerName ?? '—'}`);
  out.push(`team:     ${task.teamName ?? '—'}`);
  const short = task.shortId ?? shortFromUuid(task.uuid);
  if (short) out.push(`id:       ${short}`);
  if (task.uuid) out.push(`uuid:     ${task.uuid}`);
  out.push('');
  out.push('── timestamps ──');
  out.push(`created:   ${formatSec(task.createdAt)}`);
  if (task.updatedAt && task.updatedAt !== task.createdAt) {
    out.push(`claimed:   ${formatSec(task.updatedAt)}`);
  }
  if (task.completedAt) {
    out.push(`completed: ${formatSec(task.completedAt)}`);
  }
  out.push('');
  out.push('── description ──');
  const description = (task.description ?? '').trim();
  if (!description) {
    out.push('(no description)');
  } else {
    for (const raw of description.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line === '') {
        out.push('');
        continue;
      }
      out.push(...wrap(line, width));
    }
  }
  const events = task.linkedEvents ?? [];
  if (events.length > 0) {
    out.push('');
    out.push('── linked events ──');
    for (const id of events) out.push(`• ${id}`);
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

function shortFromUuid(uuid: string | undefined): string | undefined {
  if (!uuid) return undefined;
  return `#${uuid.slice(0, 8)}`;
}

function formatSec(sec: number | null | undefined): string {
  if (!sec) return '—';
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

function colorForTone(tone: TaskSurfaceState['tone']): string {
  switch (tone) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'neutral':
      return 'gray';
  }
}
