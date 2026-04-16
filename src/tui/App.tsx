import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import { NewsPanel } from './components/NewsPanel.js';
import type { Agent, NewsItem, Team } from './api/types.js';
import {
  fetchAgentNews,
  fetchAgentsAllTeams,
  fetchTeams,
  getManagerUrl,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const NEWS_POLL_MS = 3000;
const NEWS_MAX_ITEMS = 5;
const NEWS_CHROME_ROWS = 3 + NEWS_MAX_ITEMS;
const CHROME_ROWS = 14 + NEWS_CHROME_ROWS;
const MIN_VISIBLE = 3;
const SELF_AGENT = 'tui';
const TERMINAL_CONTENT_WIDTH = 76;
const NEWS_MESSAGE_WIDTH = TERMINAL_CONTENT_WIDTH - 8 - 1 - 17;

export function App(): React.ReactElement {
  const manager = useMemo(getManagerUrl, []);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [paused, setPaused] = useState(false);

  const teamsPoll = usePolling<Team[]>(
    (signal) => fetchTeams(manager, signal),
    TEAMS_POLL_MS,
    paused,
    [manager],
  );
  const teams = teamsPoll.data ?? [];

  const agentsFetcher = useCallback(
    (signal: AbortSignal): Promise<Agent[]> => {
      if (teams.length === 0) return Promise.resolve([]);
      return fetchAgentsAllTeams(manager, teams, signal);
    },
    [manager, teams],
  );

  const agentsPoll = usePolling<Agent[]>(agentsFetcher, AGENTS_POLL_MS, paused, [
    manager,
    teams.length,
  ]);
  const allAgents = agentsPoll.data ?? [];

  const visibleAgents = useMemo(
    () =>
      selectedTeam === null
        ? allAgents
        : allAgents.filter((a) => a.teamName === selectedTeam),
    [allAgents, selectedTeam],
  );

  const teamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of allAgents) {
      if (!a.teamName) continue;
      counts.set(a.teamName, (counts.get(a.teamName) ?? 0) + 1);
    }
    return counts;
  }, [allAgents]);

  const rows = stdout?.rows ?? 30;
  const windowSize = Math.max(MIN_VISIBLE, rows - CHROME_ROWS);
  const total = visibleAgents.length;

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

  const rowNow = agentsPoll.lastUpdated > 0 ? agentsPoll.lastUpdated : Date.now();

  const selectedAgentName: string | null =
    visibleAgents[selectedIndex]?.name ?? null;

  const newsFetcher = useCallback(
    (signal: AbortSignal): Promise<NewsItem[]> => {
      if (!selectedAgentName) return Promise.resolve([]);
      return fetchAgentNews(manager, SELF_AGENT, selectedAgentName, signal);
    },
    [manager, selectedAgentName],
  );

  const newsPoll = usePolling<NewsItem[]>(newsFetcher, NEWS_POLL_MS, paused, [
    manager,
    selectedAgentName ?? '',
  ]);

  return (
    <Box flexDirection="column">
      <Header managerUrl={manager} />
      <TeamsPanel
        teams={teams}
        selectedTeam={selectedTeam}
        allCount={allAgents.length}
        teamCounts={teamCounts}
      />
      <AgentsTable
        agents={visibleAgents}
        selectedIndex={selectedIndex}
        windowStart={windowStart}
        windowSize={windowSize}
        now={rowNow}
        loading={agentsPoll.lastUpdated === 0 && !agentsPoll.error}
        error={agentsPoll.error}
      />
      <NewsPanel
        agentName={selectedAgentName}
        items={selectedAgentName ? newsPoll.data : null}
        loading={newsPoll.lastUpdated === 0 && !newsPoll.error}
        error={newsPoll.error}
        maxItems={NEWS_MAX_ITEMS}
        messageWidth={NEWS_MESSAGE_WIDTH}
      />
      {teamsPoll.error ? (
        <Box paddingX={1}>
          <Text color="red">teams error: {teamsPoll.error.message}</Text>
        </Box>
      ) : null}
      <Footer paused={paused} lastUpdated={agentsPoll.lastUpdated} />
    </Box>
  );
}

function isHomeKey(input: string): boolean {
  return input === '\u001b[H' || input === '\u001bOH' || input === '\u001b[1~';
}

function isEndKey(input: string): boolean {
  return input === '\u001b[F' || input === '\u001bOF' || input === '\u001b[4~';
}
