import React from 'react';
import { Box, Text } from 'ink';
import type { Team } from '../api/types.js';

interface TeamsPanelProps {
  teams: Team[];
  selectedTeam: string | null;
  allCount: number;
  teamCounts: Map<string, number>;
}

export function TeamsPanel(props: TeamsPanelProps): React.ReactElement {
  const { teams, selectedTeam, allCount, teamCounts } = props;
  const allSelected = selectedTeam === null;

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text bold>Teams: </Text>
      <Chip label={`All (${allCount})`} active={allSelected} />
      {teams.map((t) => {
        const count = teamCounts.get(t.name) ?? 0;
        return (
          <React.Fragment key={t.id}>
            <Text> </Text>
            <Chip label={`${t.name} (${count})`} active={t.name === selectedTeam} />
          </React.Fragment>
        );
      })}
    </Box>
  );
}

function Chip({ label, active }: { label: string; active: boolean }): React.ReactElement {
  if (active) return <Text inverse> {label} </Text>;
  return <Text dimColor> {label} </Text>;
}
