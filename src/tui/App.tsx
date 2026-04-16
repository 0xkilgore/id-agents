import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Footer } from './components/Footer.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import { NewsView } from './components/NewsView.js';
import { StatusStrip } from './components/StatusStrip.js';
import type { Agent, NewsItem, Team } from './api/types.js';
import {
  fetchAgentNews,
  fetchAgentsAllTeams,
  fetchTeams,
  getManagerUrl,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';
import { humanizeUptime } from './util/format.js';

type View = 'agents' | 'news';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const NEWS_POLL_MS = 3000;
const NEWS_COOLDOWN_TICK_MS = 10_000;
const AGENTS_CHROME_ROWS = 11;
const NEWS_CHROME_ROWS = 6;
const MIN_VISIBLE = 3;
const SELF_AGENT = 'tui';
const TERMINAL_CONTENT_WIDTH = 76;
const NEWS_MESSAGE_WIDTH = TERMINAL_CONTENT_WIDTH - 8 - 1 - 17 - 4;

interface AppProps {
  staticMode?: boolean;
}

export function App({ staticMode = false }: AppProps = {}): React.ReactElement {
  const manager = useMemo(getManagerUrl, []);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [staticTeams, setStaticTeams] = useState<Team[] | null>(null);
  const [staticAllAgents, setStaticAllAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    if (!staticMode) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const ts = await fetchTeams(manager, ac.signal);
        const ags = await fetchAgentsAllTeams(manager, ts, ac.signal);
        if (!ac.signal.aborted) {
          setStaticTeams(ts);
          setStaticAllAgents(ags);
        }
      } catch {
        /* swallow — diagnostic */
      }
    })();
    return () => ac.abort();
  }, [staticMode, manager]);

  const [view, setView] = useState<View>('agents');
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [newsSelectedIndex, setNewsSelectedIndex] = useState(0);
  const [newsWindowStart, setNewsWindowStart] = useState(0);
  const [paused, setPaused] = useState(false);
  const [cooldownEpoch, setCooldownEpoch] = useState<number>(() => Date.now());

  useEffect(() => {
    if (view !== 'news' || paused || staticMode) return;
    setCooldownEpoch(Date.now());
    const id = setInterval(() => setCooldownEpoch(Date.now()), NEWS_COOLDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [view, paused, staticMode]);

  const teamsPoll = usePolling<Team[]>(
    (signal) => fetchTeams(manager, signal),
    TEAMS_POLL_MS,
    paused || staticMode,
    [manager],
  );
  const teams = staticMode ? staticTeams ?? [] : teamsPoll.data ?? [];

  const agentsFetcher = useCallback(
    (signal: AbortSignal): Promise<Agent[]> => {
      if (teams.length === 0) return Promise.resolve([]);
      return fetchAgentsAllTeams(manager, teams, signal);
    },
    [manager, teams],
  );

  const agentsPoll = usePolling<Agent[]>(
    agentsFetcher,
    AGENTS_POLL_MS,
    paused || staticMode,
    [manager, teams.length],
  );
  const allAgents = staticMode ? staticAllAgents ?? [] : agentsPoll.data ?? [];

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

  const pollTs = staticMode
    ? staticAllAgents !== null
      ? Date.now()
      : 0
    : agentsPoll.lastUpdated;

  const uptimeById = useMemo(() => {
    const map = new Map<string, string>();
    if (pollTs === 0) return map;
    for (const a of allAgents) {
      map.set(a.id, humanizeUptime(a.createdAt, pollTs));
    }
    return map;
  }, [allAgents, pollTs]);

  const rows = stdout?.rows ?? 30;
  const agentsWindowSize = Math.max(MIN_VISIBLE, rows - AGENTS_CHROME_ROWS - 1);
  const newsWindowSize = Math.max(MIN_VISIBLE, rows - NEWS_CHROME_ROWS - 1);
  const total = visibleAgents.length;

  useEffect(() => {
    if (total === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      if (windowStart !== 0) setWindowStart(0);
      return;
    }
    const clampedSel = Math.min(selectedIndex, total - 1);
    if (clampedSel !== selectedIndex) setSelectedIndex(clampedSel);
    const maxStart = Math.max(0, total - agentsWindowSize);
    let nextStart = windowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + agentsWindowSize)
      nextStart = clampedSel - agentsWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== windowStart) setWindowStart(nextStart);
  }, [total, selectedIndex, windowStart, agentsWindowSize]);

  const selectedAgent = visibleAgents[selectedIndex] ?? null;
  const selectedAgentName: string | null = selectedAgent?.name ?? null;
  const selectedAgentId: string | null = selectedAgent?.id ?? null;

  const newsFetcher = useCallback(
    (signal: AbortSignal): Promise<NewsItem[]> => {
      if (!selectedAgentName) return Promise.resolve([]);
      return fetchAgentNews(manager, SELF_AGENT, selectedAgentName, signal);
    },
    [manager, selectedAgentName],
  );

  const newsPoll = usePolling<NewsItem[]>(
    newsFetcher,
    NEWS_POLL_MS,
    paused || staticMode || view !== 'news',
    [manager, selectedAgentName ?? '', view],
  );
  const newsItems = newsPoll.data ?? [];
  const newsTotal = newsItems.length;

  useEffect(() => {
    if (newsTotal === 0) {
      if (newsSelectedIndex !== 0) setNewsSelectedIndex(0);
      if (newsWindowStart !== 0) setNewsWindowStart(0);
      return;
    }
    const clampedSel = Math.min(newsSelectedIndex, newsTotal - 1);
    if (clampedSel !== newsSelectedIndex) setNewsSelectedIndex(clampedSel);
    const maxStart = Math.max(0, newsTotal - newsWindowSize);
    let nextStart = newsWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + newsWindowSize)
      nextStart = clampedSel - newsWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== newsWindowStart) setNewsWindowStart(nextStart);
  }, [newsTotal, newsSelectedIndex, newsWindowStart, newsWindowSize]);

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

  const moveAgentsSel = useCallback(
    (delta: number) => {
      if (total === 0) return;
      setSelectedIndex((idx) => clamp(idx + delta, 0, total - 1));
    },
    [total],
  );

  const moveNewsSel = useCallback(
    (delta: number) => {
      if (newsTotal === 0) return;
      setNewsSelectedIndex((idx) => clamp(idx + delta, 0, newsTotal - 1));
    },
    [newsTotal],
  );

  const openNews = useCallback(() => {
    if (!selectedAgentName) return;
    setNewsSelectedIndex(0);
    setNewsWindowStart(0);
    setView('news');
  }, [selectedAgentName]);

  const backToAgents = useCallback(() => {
    setView('agents');
  }, []);

  useInput(
    (input, key) => {
      // global
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit();
        return;
      }
      if (input === 'p') {
        setPaused((p) => !p);
        return;
      }

      if (view === 'agents') {
        if (key.rightArrow) return openNews();
        if (key.tab) return cycleTeam(key.shift ? -1 : 1);
        if (key.upArrow) return moveAgentsSel(-1);
        if (key.downArrow) return moveAgentsSel(1);
        if (key.pageUp) return moveAgentsSel(-agentsWindowSize);
        if (key.pageDown) return moveAgentsSel(agentsWindowSize);
        if (isHomeKey(input)) return setSelectedIndex(0);
        if (isEndKey(input)) return setSelectedIndex(Math.max(0, total - 1));
        return;
      }

      // news view
      if (key.leftArrow || key.escape) return backToAgents();
      if (key.upArrow) return moveNewsSel(-1);
      if (key.downArrow) return moveNewsSel(1);
      if (key.pageUp) return moveNewsSel(-newsWindowSize);
      if (key.pageDown) return moveNewsSel(newsWindowSize);
      if (isHomeKey(input)) return setNewsSelectedIndex(0);
      if (isEndKey(input)) return setNewsSelectedIndex(Math.max(0, newsTotal - 1));
    },
    { isActive: process.stdin.isTTY === true },
  );

  return (
    <Box flexDirection="column">
      {view === 'agents' ? (
        <>
          <TeamsPanel
            teams={teams}
            selectedTeam={selectedTeam}
            allCount={allAgents.length}
            teamCounts={teamCounts}
          />
          <StatusStrip agents={allAgents} selectedAgentId={selectedAgentId} />
          <AgentsTable
            agents={visibleAgents}
            uptimeById={uptimeById}
            selectedIndex={selectedIndex}
            windowStart={windowStart}
            windowSize={agentsWindowSize}
            loading={agentsPoll.lastUpdated === 0 && !agentsPoll.error && !staticMode}
            error={agentsPoll.error}
          />
          {teamsPoll.error ? (
            <Box paddingX={1}>
              <Text color="red">teams error: {teamsPoll.error.message}</Text>
            </Box>
          ) : null}
        </>
      ) : (
        <NewsView
          agentName={selectedAgentName}
          items={newsItems}
          loading={newsPoll.lastUpdated === 0 && !newsPoll.error}
          error={newsPoll.error}
          windowStart={newsWindowStart}
          windowSize={newsWindowSize}
          selectedIndex={newsSelectedIndex}
          messageWidth={NEWS_MESSAGE_WIDTH}
          cooldownEpoch={cooldownEpoch}
        />
      )}
      <Footer view={view} paused={paused} />
    </Box>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function isHomeKey(input: string): boolean {
  return input === '\u001b[H' || input === '\u001bOH' || input === '\u001b[1~';
}

function isEndKey(input: string): boolean {
  return input === '\u001b[F' || input === '\u001bOF' || input === '\u001b[4~';
}
