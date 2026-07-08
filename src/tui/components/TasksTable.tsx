import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '../api/types.js';
import { TaskRow, TaskRowHeader } from './TaskRow.js';
import type { TaskSurfaceState } from '../tasks/task-surface-state.js';

interface TasksTableProps {
  tasks: Task[];
  totalCount: number;
  ageByName: ReadonlyMap<string, string>;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  surface: TaskSurfaceState;
}

export function TasksTable(props: TasksTableProps): React.ReactElement {
  const { tasks, totalCount, ageByName, selectedIndex, windowStart, windowSize, surface } = props;
  const total = tasks.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = tasks.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;
  const statusColor = colorForTone(surface.tone);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Tasks ({total})</Text>
        <Text color={statusColor}>
          {surface.label}
          {surface.detail ? <Text dimColor> · {surface.detail}</Text> : null}
        </Text>
      </Box>
      {total !== totalCount ? (
        <Text dimColor>showing {total} of {totalCount} tasks · press r to refresh</Text>
      ) : (
        <Text dimColor>{totalCount} tasks in read model · press r to refresh</Text>
      )}
      <TaskRowHeader />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 ? (
        <Text dimColor>{surface.emptyLabel ?? 'no tasks in this view'}</Text>
      ) : (
        visible.map((task, i) => (
          <TaskRow
            key={task.name}
            task={task}
            age={ageByName.get(task.name) ?? '—'}
            selected={windowStart + i === selectedIndex}
          />
        ))
      )}
      {Array.from(
        {
          length: Math.max(
            0,
            windowSize -
              Math.max(visible.length, visible.length === 0 ? 1 : 0),
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
