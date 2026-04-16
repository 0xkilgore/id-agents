import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import type { Agent, Team } from './api/types.js';
import {
  fetchAgentsAllTeams,
  fetchAgentsByTeam,
  fetchTeams,
  getManagerUrl,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';
import { humanizeAge } from './util/format.js';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const CLOCK_TICK_MS = 1000;
const CHROME_ROWS = 14;
const MIN_VISIBLE = 5;

export function App(): React.ReactElement {
  const manager = useMemo(getManagerUrl, []);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const teamsPoll = usePolling<Team[]>(
    (signal) => fetchTeams(manager, signal),
    TEAMS_POLL_MS,
    paused,
    [manager],
  );
  const teams = teamsPoll.data ?? [];

  const agentsFetcher = useCallback(
    (signal: AbortSignal): Promise<Agent[]> => {
      if (selectedTeam === null) {
        if (teams.length === 0) return Promise.resolve([]);
        return fetchAgentsAllTeams(manager, teams, signal);
      }
      return fetchAgentsByTeam(manager, selectedTeam, signal);
    },
    [manager, selectedTeam, teams],
  );

  const agentsPoll = usePolling<Agent[]>(
    agentsFetcher,
    AGENTS_POLL_MS,
    paused,
    [manager, selectedTeam, teams.length],
  );
  const agents = agentsPoll.data ?? [];

  const rows = stdout?.rows ?? 30;
  const windowSize = Math.max(MIN_VISIBLE, rows - CHROME_ROWS);
  const total = agents.length;

  useEffect(() => {
    if (total === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      if (windowStart !== 0) setWindowStart(0);
      return;
    }
    const clampedSel = Math.min(selectedIndex, total - 1);
    if (clampedSel !== selectedIndex) setSelectedIndex(clampedSel);
    const maxStart = Math.max(0, total - windowSize);
    let nextStart = windowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + windowSize) nextStart = clampedSel - windowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== windowStart) setWindowStart(nextStart);
  }, [total, selectedIndex, windowStart, windowSize]);

  const teamOptions: Array<string | null> = useMemo(
    () => [null, ...teams.map((t) => t.name)],
    [teams],
  );

  const cycleTeam = useCallback(
    (dir: 1 | -1) => {
      if (teamOptions.length === 0) return;
      const current = teamOptions.indexOf(selectedTeam);
      const base = current === -1 ? 0 : current;
      const next = (base + dir + teamOptions.length) % teamOptions.length;
      setSelectedTeam(teamOptions[next]);
      setSelectedIndex(0);
      setWindowStart(0);
    },
    [teamOptions, selectedTeam],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (total === 0) return;
      setSelectedIndex((idx) => {
        const next = idx + delta;
        if (next < 0) return 0;
        if (next > total - 1) return total - 1;
        return next;
      });
    },
    [total],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      if (total === 0) return;
      setSelectedIndex(Math.max(0, Math.min(total - 1, idx)));
    },
    [total],
  );

  useInput(
    (input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit();
        return;
      }
      if (input === 'p') {
        setPaused((p) => !p);
        return;
      }
      if (key.tab) {
        cycleTeam(key.shift ? -1 : 1);
        return;
      }
      if (key.upArrow) return moveSelection(-1);
      if (key.downArrow) return moveSelection(1);
      if (key.pageUp) return moveSelection(-windowSize);
      if (key.pageDown) return moveSelection(windowSize);
      if (isHomeKey(input)) return jumpTo(0);
      if (isEndKey(input)) return jumpTo(total - 1);
    },
    { isActive: process.stdin.isTTY === true },
  );

  const lastUpdatedAgo =
    agentsPoll.lastUpdated > 0 ? humanizeAge(agentsPoll.lastUpdated, now) : undefined;

  return (
    <Box flexDirection="column">
      <Header managerUrl={manager} />
      <TeamsPanel teams={teams} selectedTeam={selectedTeam} totalVisibleAgents={total} />
      <AgentsTable
        agents={agents}
        selectedIndex={selectedIndex}
        windowStart={windowStart}
        windowSize={windowSize}
        now={now}
        loading={agentsPoll.lastUpdated === 0 && !agentsPoll.error}
        error={agentsPoll.error}
      />
      {teamsPoll.error ? (
        <Box paddingX={1}>
          <Text color="red">teams error: {teamsPoll.error.message}</Text>
        </Box>
      ) : null}
      <Footer paused={paused} lastUpdatedAgo={lastUpdatedAgo} />
    </Box>
  );
}

function isHomeKey(input: string): boolean {
  return input === '\u001b[H' || input === '\u001bOH' || input === '\u001b[1~';
}

function isEndKey(input: string): boolean {
  return input === '\u001b[F' || input === '\u001bOF' || input === '\u001b[4~';
}
