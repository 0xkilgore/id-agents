import React from 'react';
import { Box, Text } from 'ink';

interface HelpModalProps {
  width?: number;
}

interface Group {
  title: string;
  rows: Array<[string, string]>; // [keybind, description]
}

const GROUPS: Group[] = [
  {
    title: 'Views',
    rows: [
      ['a', 'Agents — running agents in the current team'],
      ['t', 'Tasks — manager task list (toggle from agents)'],
      ['n', 'News — feed for the selected agent (from agents view)'],
      ['c', 'Calendar — scheduled events'],
      ['h', 'Heartbeats — periodic agent self-checks'],
      ['l', 'Library — available agent personas'],
      ['s', 'Skills — available skill packs'],
    ],
  },
  {
    title: 'Navigate',
    rows: [
      ['↑ / ↓', 'Move row selection up / down'],
      ['PgUp / PgDn', 'Move selection one window'],
      ['→', 'Open the selected row (detail / news)'],
      ['← / Esc', 'Go back to the previous view'],
      ['Tab', 'Cycle to next team (Shift+Tab for previous)'],
    ],
  },
  {
    title: 'Global',
    rows: [
      ['?', 'Show / hide this help'],
      ['q', 'Quit (asks to confirm)'],
      ['Ctrl+C', 'Force quit immediately'],
    ],
  },
];

export function HelpModal(_props: HelpModalProps): React.ReactElement {
  const keyWidth = 14;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">  Help</Text>
        <Text dimColor>? or Esc to close</Text>
      </Box>
      {GROUPS.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={1}>
          <Text bold>{group.title}</Text>
          {group.rows.map(([keybind, desc]) => (
            <Box key={keybind}>
              <Box width={keyWidth}>
                <Text color="yellow">{`  ${keybind}`}</Text>
              </Box>
              <Text>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
