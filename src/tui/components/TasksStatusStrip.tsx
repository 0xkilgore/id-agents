import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '../api/types.js';
import { taskStatusColor, taskStatusGlyph } from '../util/colors.js';

interface TasksStatusStripProps {
  tasks: Task[];
  selectedTaskName: string | null;
}

interface TeamGroup {
  team: string;
  list: Task[];
}

export function TasksStatusStrip(props: TasksStatusStripProps): React.ReactElement {
  const { tasks, selectedTaskName } = props;
  const groups = groupByTeam(tasks);

  return (
    <Box paddingX={1}>
      {groups.length === 0 ? (
        <Text dimColor>no tasks</Text>
      ) : (
        groups.map((g, ti) => (
          <React.Fragment key={g.team}>
            {ti > 0 ? <Text dimColor> │ </Text> : null}
            <Text dimColor>{g.team} </Text>
            {g.list.map((t) => (
              <Glyph key={t.name} task={t} selected={t.name === selectedTaskName} />
            ))}
          </React.Fragment>
        ))
      )}
    </Box>
  );
}

interface GlyphProps {
  task: Task;
  selected: boolean;
}

function Glyph({ task, selected }: GlyphProps): React.ReactElement {
  return (
    <Text color={taskStatusColor(task.status)} underline={selected} bold={selected}>
      {taskStatusGlyph(task.status)}
    </Text>
  );
}

function groupByTeam(tasks: Task[]): TeamGroup[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const team = t.teamName ?? '(no team)';
    const list = map.get(team) ?? [];
    list.push(t);
    map.set(team, list);
  }
  const groups: TeamGroup[] = [];
  for (const [team, list] of map) {
    groups.push({
      team,
      list: [...list].sort((a, b) => a.createdAt - b.createdAt),
    });
  }
  groups.sort((a, b) => a.team.localeCompare(b.team));
  return groups;
}
