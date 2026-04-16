import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../api/types.js';

interface StatusStripProps {
  agents: Agent[];
  selectedAgentId: string | null;
}

interface TeamGroup {
  team: string;
  list: Agent[];
}

export function StatusStrip(props: StatusStripProps): React.ReactElement {
  const { agents, selectedAgentId } = props;
  const groups = groupByTeam(agents);

  return (
    <Box paddingX={1}>
      {groups.length === 0 ? (
        <Text dimColor>no agents</Text>
      ) : (
        groups.map((g, ti) => (
          <React.Fragment key={g.team}>
            {ti > 0 ? <Text dimColor> │ </Text> : null}
            <Text dimColor>{g.team} </Text>
            {g.list.map((agent) => (
              <Symbol
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedAgentId}
              />
            ))}
          </React.Fragment>
        ))
      )}
    </Box>
  );
}

interface SymbolProps {
  agent: Agent;
  selected: boolean;
}

function Symbol({ agent, selected }: SymbolProps): React.ReactElement {
  const { glyph, color } = symbolFor(agent);
  return (
    <Text color={color} underline={selected} bold={selected}>
      {glyph}
    </Text>
  );
}

function symbolFor(agent: Agent): { glyph: string; color: string } {
  if (agent.health === 'online') return { glyph: '●', color: 'green' };
  if (agent.status === 'running') return { glyph: '●', color: 'yellow' };
  return { glyph: '○', color: 'gray' };
}

function groupByTeam(agents: Agent[]): TeamGroup[] {
  const map = new Map<string, Agent[]>();
  for (const a of agents) {
    const team = a.teamName ?? '(no team)';
    const list = map.get(team) ?? [];
    list.push(a);
    map.set(team, list);
  }
  const groups: TeamGroup[] = [];
  for (const [team, list] of map) {
    groups.push({
      team,
      list: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  groups.sort((a, b) => a.team.localeCompare(b.team));
  return groups;
}
