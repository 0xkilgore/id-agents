import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '../api/types.js';
import { TaskRow, TaskRowHeader } from './TaskRow.js';

interface TasksTableProps {
  tasks: Task[];
  ageByName: ReadonlyMap<string, string>;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
}

export function TasksTable(props: TasksTableProps): React.ReactElement {
  const { tasks, ageByName, selectedIndex, windowStart, windowSize, loading, error } = props;
  const total = tasks.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = tasks.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Tasks ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
        </Text>
      </Box>
      <TaskRowHeader />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>no tasks in this view</Text>
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
