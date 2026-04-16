import React from 'react';
import { Text } from 'ink';
import type { Task } from '../api/types.js';
import { padRight } from '../util/format.js';
import { taskStatusColor } from '../util/colors.js';

interface TaskRowProps {
  task: Task;
  selected: boolean;
  age: string;
}

const COLS = {
  marker: 2,
  status: 7,
  name: 25,
  title: 26,
  owner: 10,
  age: 6,
} as const;

function TaskRowInner({ task, selected, age }: TaskRowProps): React.ReactElement {
  const marker = selected ? '▶ ' : '  ';
  const status = padRight(task.status, COLS.status);
  const name = padRight(task.name, COLS.name);
  const title = padRight(task.title, COLS.title);
  const owner = padRight(task.ownerName ?? '—', COLS.owner);
  const ageCell = padRight(age, COLS.age);
  const sColor = taskStatusColor(task.status);

  return (
    <Text inverse={selected}>
      {marker}
      <Text color={sColor}>{status}</Text>
      {name}
      {title}
      {owner}
      {ageCell}
    </Text>
  );
}

export const TaskRow = React.memo(TaskRowInner, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.age !== next.age) return false;
  const a = prev.task;
  const b = next.task;
  return (
    a.name === b.name &&
    a.title === b.title &&
    a.status === b.status &&
    a.ownerName === b.ownerName &&
    a.teamName === b.teamName &&
    a.updatedAt === b.updatedAt
  );
});

export function TaskRowHeader(): React.ReactElement {
  return (
    <Text bold dimColor>
      {padRight('', COLS.marker)}
      {padRight('STATUS', COLS.status)}
      {padRight('NAME', COLS.name)}
      {padRight('TITLE', COLS.title)}
      {padRight('OWNER', COLS.owner)}
      {padRight('AGE', COLS.age)}
    </Text>
  );
}
