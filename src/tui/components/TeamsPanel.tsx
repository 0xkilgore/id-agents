import React from 'react';
import { Box, Text } from 'ink';
import type { Team } from '../api/types.js';

interface TeamsPanelProps {
  teams: Team[];
  selectedTeam: string | null;
  allCount: number;
  teamCounts: Map<string, number>;
}

// How many team chips to show alongside the always-visible "All" chip.
// When the team list is longer than this, the visible window centers on
// the selected team and `←N` / `N→` indicators show how many are hidden.
// Tab / Shift+Tab cycle the selection; the window slides automatically.
const MAX_VISIBLE = 5;

export function TeamsPanel(props: TeamsPanelProps): React.ReactElement {
  const { teams, selectedTeam, allCount, teamCounts } = props;
  const allSelected = selectedTeam === null;
  const total = teams.length;

  // Compute the visible window. When `All` is active (no specific team),
  // anchor at index 0. Otherwise center on the selected team and clamp
  // to valid bounds.
  let start = 0;
  let end = Math.min(MAX_VISIBLE, total);

  if (total > MAX_VISIBLE) {
    const selectedIdx = teams.findIndex((t) => t.name === selectedTeam);
    if (selectedIdx >= 0) {
      start = Math.max(0, selectedIdx - Math.floor(MAX_VISIBLE / 2));
      end = start + MAX_VISIBLE;
      if (end > total) {
        end = total;
        start = total - MAX_VISIBLE;
      }
    }
  }

  const visible = teams.slice(start, end);
  const leftHidden = start;
  const rightHidden = total - end;

  return (
    <Box borderStyle="round">
      <Text bold> Teams: </Text>
      <Chip label={`All (${allCount})`} active={allSelected} />
      {leftHidden > 0 ? (
        <>
          <Text> </Text>
          <Text dimColor>{`←${leftHidden}`}</Text>
        </>
      ) : null}
      {visible.map((t) => {
        const count = teamCounts.get(t.name) ?? 0;
        return (
          <React.Fragment key={t.id}>
            <Text> </Text>
            <Chip label={`${t.name} (${count})`} active={t.name === selectedTeam} />
          </React.Fragment>
        );
      })}
      {rightHidden > 0 ? (
        <>
          <Text> </Text>
          <Text dimColor>{`${rightHidden}→`}</Text>
        </>
      ) : null}
    </Box>
  );
}

function Chip({ label, active }: { label: string; active: boolean }): React.ReactElement {
  if (active) return <Text inverse> {label} </Text>;
  return <Text dimColor> {label} </Text>;
}
