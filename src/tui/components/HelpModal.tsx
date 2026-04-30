import React from 'react';
import { Box, Text } from 'ink';

interface Group {
  title: string;
  rows: Array<[string, string]>; // [keybind, short description]
}

const VIEWS: Group = {
  title: 'Views',
  rows: [
    ['a', 'Agents'],
    ['t', 'Tasks'],
    ['n', 'News'],
    ['c', 'Calendar'],
    ['h', 'Heartbeats'],
    ['l', 'Library'],
    ['s', 'Skills'],
  ],
};

const NAVIGATE: Group = {
  title: 'Navigate',
  rows: [
    ['↑ ↓', 'Move row'],
    ['PgUp/Dn', 'Move page'],
    ['→', 'Open detail'],
    ['← Esc', 'Back'],
    ['Tab', 'Cycle team'],
  ],
};

const GLOBAL: Group = {
  title: 'Global',
  rows: [
    ['?', 'Toggle help'],
    ['q', 'Quit'],
    ['^C', 'Force quit'],
  ],
};

function Column({ group, keyWidth }: { group: Group; keyWidth: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold>{group.title}</Text>
      {group.rows.map(([keybind, desc]) => (
        <Box key={keybind}>
          <Box width={keyWidth}>
            <Text color="yellow">{keybind}</Text>
          </Box>
          <Text>{desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function HelpModal(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Help</Text>
        <Text dimColor>? · Esc to close</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Column group={VIEWS} keyWidth={3} />
        <Column group={NAVIGATE} keyWidth={9} />
        <Column group={GLOBAL} keyWidth={4} />
      </Box>
    </Box>
  );
}
