import React from 'react';
import { Box, Text } from 'ink';
import type { Team } from '../api/types.js';

interface TeamsPanelProps {
  teams: Team[];
  selectedTeam: string | null;
  totalVisibleAgents: number;
}

export function TeamsPanel(props: TeamsPanelProps): React.ReactElement {
  const { teams, selectedTeam, totalVisibleAgents } = props;
  const allSelected = selectedTeam === null;

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text bold>Teams: </Text>
      <Chip label={`All (${totalVisibleAgents})`} active={allSelected} />
      {teams.map((t) => (
        <React.Fragment key={t.id}>
          <Text> </Text>
          <Chip label={`${t.name} (${t.agentCount})`} active={t.name === selectedTeam} />
        </React.Fragment>
      ))}
    </Box>
  );
}

function Chip({ label, active }: { label: string; active: boolean }): React.ReactElement {
  if (active) return <Text inverse> {label} </Text>;
  return <Text dimColor> {label} </Text>;
}
