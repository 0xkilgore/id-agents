import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Footer } from './components/Footer.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import { NewsView } from './components/NewsView.js';
import { NewsDetail } from './components/NewsDetail.js';
import { StatusStrip } from './components/StatusStrip.js';
import { TasksTable } from './components/TasksTable.js';
import { TaskDetail } from './components/TaskDetail.js';
import { CalendarView } from './components/CalendarView.js';
import { HeartbeatsView, type HeartbeatRow } from './components/HeartbeatsView.js';
import type { Agent, NewsItem, Schedule, Task, Team } from './api/types.js';
import {
  fetchAgentNews,
  fetchAgentsAllTeams,
  fetchSchedulesAllTeams,
  fetchTasks,
  fetchTeams,
  getManagerUrl,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';
import { humanizeUptime } from './util/format.js';

type View =
  | 'agents'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const NEWS_POLL_MS = 3000;
const TASKS_POLL_MS = 5000;
const SCHEDULES_POLL_MS = 5000;
const NEWS_COOLDOWN_TICK_MS = 10_000;
const AGENTS_CHROME_ROWS = 11;
const NEWS_CHROME_ROWS = 6;
const DETAIL_CHROME_ROWS = 6;
const TASKS_CHROME_ROWS = 10;
const CALENDAR_CHROME_ROWS = 8;
const HEARTBEATS_CHROME_ROWS = 7;
const DETAIL_CONTENT_WIDTH = 76;
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
  const [taskSelectedIndex, setTaskSelectedIndex] = useState(0);
  const [taskWindowStart, setTaskWindowStart] = useState(0);
  const [schedSelectedIndex, setSchedSelectedIndex] = useState(0);
  const [schedWindowStart, setSchedWindowStart] = useState(0);
  const [hbSelectedIndex, setHbSelectedIndex] = useState(0);
  const [hbWindowStart, setHbWindowStart] = useState(0);
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
  const agentsWindowSize = Math.max(MIN_VISIBLE, rows - AGENTS_CHROME_ROWS);
  const newsWindowSize = Math.max(MIN_VISIBLE, rows - NEWS_CHROME_ROWS);
  const detailWindowSize = Math.max(MIN_VISIBLE, rows - DETAIL_CHROME_ROWS);
  const tasksWindowSize = Math.max(MIN_VISIBLE, rows - TASKS_CHROME_ROWS);
  const calendarWindowSize = Math.max(MIN_VISIBLE, rows - CALENDAR_CHROME_ROWS);
  const heartbeatsWindowSize = Math.max(MIN_VISIBLE, rows - HEARTBEATS_CHROME_ROWS);
  const total = visibleAgents.length;

  // Tasks polling
  const tasksFetcher = useCallback(
    (signal: AbortSignal): Promise<Task[]> => fetchTasks(manager, SELF_AGENT, signal),
    [manager],
  );
  const tasksPoll = usePolling<Task[]>(
    tasksFetcher,
    TASKS_POLL_MS,
    paused || staticMode || (view !== 'tasks' && view !== 'task-detail'),
    [manager, view],
  );
  const allTasks = tasksPoll.data ?? [];
  const visibleTasks = useMemo(
    () =>
      selectedTeam === null
        ? allTasks
        : allTasks.filter((t) => t.teamName === selectedTeam),
    [allTasks, selectedTeam],
  );
  const tasksTotal = visibleTasks.length;
  const ageByTaskName = useMemo(() => {
    const map = new Map<string, string>();
    const tsPoll = tasksPoll.lastUpdated;
    if (tsPoll === 0) return map;
    for (const t of allTasks) {
      // task.createdAt is unix seconds; convert to ms for humanizeUptime
      map.set(t.name, humanizeUptime(t.createdAt * 1000, tsPoll));
    }
    return map;
  }, [allTasks, tasksPoll.lastUpdated]);

  useEffect(() => {
    if (tasksTotal === 0) {
      if (taskSelectedIndex !== 0) setTaskSelectedIndex(0);
      if (taskWindowStart !== 0) setTaskWindowStart(0);
      return;
    }
    const clampedSel = Math.min(taskSelectedIndex, tasksTotal - 1);
    if (clampedSel !== taskSelectedIndex) setTaskSelectedIndex(clampedSel);
    const maxStart = Math.max(0, tasksTotal - tasksWindowSize);
    let nextStart = taskWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + tasksWindowSize)
      nextStart = clampedSel - tasksWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== taskWindowStart) setTaskWindowStart(nextStart);
  }, [tasksTotal, taskSelectedIndex, taskWindowStart, tasksWindowSize]);

  const selectedTaskName = visibleTasks[taskSelectedIndex]?.name ?? null;

  // Schedules polling — drives Calendar view.
  const schedulesFetcher = useCallback(
    (signal: AbortSignal): Promise<Schedule[]> => {
      if (teams.length === 0) return Promise.resolve([]);
      return fetchSchedulesAllTeams(manager, SELF_AGENT, teams, signal);
    },
    [manager, teams],
  );
  const schedulesPoll = usePolling<Schedule[]>(
    schedulesFetcher,
    SCHEDULES_POLL_MS,
    paused || staticMode || (view !== 'calendar' && view !== 'heartbeats'),
    [manager, teams.length, view],
  );
  const allSchedules = schedulesPoll.data ?? [];
  // Calendar is a time-ordered, cross-team view — no team filter here.
  const schedTotal = allSchedules.length;

  const heartbeatRows = useMemo<HeartbeatRow[]>(() => {
    const pollMs = schedulesPoll.lastUpdated || Date.now();
    const nowSec = Math.floor(pollMs / 1000);
    const out: HeartbeatRow[] = [];
    for (const s of allSchedules) {
      if (s.kind !== 'heartbeat') continue;
      if (!s.intervalSeconds || s.intervalSeconds <= 0) continue;
      const anchor = s.createdAt;
      const interval = s.intervalSeconds;
      const elapsed = nowSec - anchor;
      const nLast = Math.floor(elapsed / interval);
      const lastFireSec = nLast >= 0 ? anchor + nLast * interval : null;
      const nextFireSec = anchor + (nLast + 1) * interval;
      for (const agent of s.targets) {
        out.push({ agent, schedule: s, intervalSec: interval, lastFireSec, nextFireSec });
      }
    }
    out.sort((a, b) => {
      if (a.nextFireSec !== b.nextFireSec) return a.nextFireSec - b.nextFireSec;
      return a.agent.localeCompare(b.agent);
    });
    return out;
  }, [allSchedules, schedulesPoll.lastUpdated]);

  const visibleHeartbeats = useMemo(
    () =>
      selectedTeam === null
        ? heartbeatRows
        : heartbeatRows.filter((r) => r.schedule.teamName === selectedTeam),
    [heartbeatRows, selectedTeam],
  );
  const hbTotal = visibleHeartbeats.length;
  const heartbeatsTeamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of heartbeatRows) {
      if (!r.schedule.teamName) continue;
      counts.set(r.schedule.teamName, (counts.get(r.schedule.teamName) ?? 0) + 1);
    }
    return counts;
  }, [heartbeatRows]);

  useEffect(() => {
    if (hbTotal === 0) {
      if (hbSelectedIndex !== 0) setHbSelectedIndex(0);
      if (hbWindowStart !== 0) setHbWindowStart(0);
      return;
    }
    const clampedSel = Math.min(hbSelectedIndex, hbTotal - 1);
    if (clampedSel !== hbSelectedIndex) setHbSelectedIndex(clampedSel);
    const maxStart = Math.max(0, hbTotal - heartbeatsWindowSize);
    let nextStart = hbWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + heartbeatsWindowSize)
      nextStart = clampedSel - heartbeatsWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== hbWindowStart) setHbWindowStart(nextStart);
  }, [hbTotal, hbSelectedIndex, hbWindowStart, heartbeatsWindowSize]);

  useEffect(() => {
    if (schedTotal === 0) {
      if (schedSelectedIndex !== 0) setSchedSelectedIndex(0);
      if (schedWindowStart !== 0) setSchedWindowStart(0);
      return;
    }
    const clampedSel = Math.min(schedSelectedIndex, schedTotal - 1);
    if (clampedSel !== schedSelectedIndex) setSchedSelectedIndex(clampedSel);
    const maxStart = Math.max(0, schedTotal - calendarWindowSize);
    let nextStart = schedWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + calendarWindowSize)
      nextStart = clampedSel - calendarWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== schedWindowStart) setSchedWindowStart(nextStart);
  }, [schedTotal, schedSelectedIndex, schedWindowStart, calendarWindowSize]);

  const tasksTeamCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTasks) {
      if (!t.teamName) continue;
      counts.set(t.teamName, (counts.get(t.teamName) ?? 0) + 1);
    }
    return counts;
  }, [allTasks]);

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
    paused || staticMode || (view !== 'news' && view !== 'news-detail'),
    [manager, selectedAgentName ?? '', view],
  );
  const newsItems = newsPoll.data ?? [];
  const sortedNewsItems = useMemo(
    () => [...newsItems].sort((a, b) => b.timestamp - a.timestamp),
    [newsItems],
  );
  const newsTotal = sortedNewsItems.length;
  const selectedNewsItem: NewsItem | null = sortedNewsItems[newsSelectedIndex] ?? null;

  const [detailScroll, setDetailScroll] = useState(0);
  const [taskDetailScroll, setTaskDetailScroll] = useState(0);

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

  const moveTaskSel = useCallback(
    (delta: number) => {
      if (tasksTotal === 0) return;
      setTaskSelectedIndex((idx) => clamp(idx + delta, 0, tasksTotal - 1));
    },
    [tasksTotal],
  );

  const toggleTasksView = useCallback(() => {
    setView((v) => (v === 'tasks' ? 'agents' : v === 'agents' ? 'tasks' : v));
  }, []);

  const moveSchedSel = useCallback(
    (delta: number) => {
      if (schedTotal === 0) return;
      setSchedSelectedIndex((idx) => clamp(idx + delta, 0, schedTotal - 1));
    },
    [schedTotal],
  );

  const openCalendar = useCallback(() => {
    setSchedSelectedIndex(0);
    setSchedWindowStart(0);
    setView('calendar');
  }, []);

  const openHeartbeats = useCallback(() => {
    setHbSelectedIndex(0);
    setHbWindowStart(0);
    setView('heartbeats');
  }, []);

  const moveHbSel = useCallback(
    (delta: number) => {
      if (hbTotal === 0) return;
      setHbSelectedIndex((idx) => clamp(idx + delta, 0, hbTotal - 1));
    },
    [hbTotal],
  );

  const openNews = useCallback(() => {
    if (!selectedAgentName) return;
    setNewsSelectedIndex(0);
    setNewsWindowStart(0);
    setView('news');
  }, [selectedAgentName]);

  const openNewsDetail = useCallback(() => {
    if (!selectedNewsItem) return;
    setDetailScroll(0);
    setView('news-detail');
  }, [selectedNewsItem]);

  const openTaskDetail = useCallback(() => {
    if (tasksTotal === 0) return;
    setTaskDetailScroll(0);
    setView('task-detail');
  }, [tasksTotal]);

  const backToTasks = useCallback(() => {
    setView('tasks');
  }, []);

  const moveTaskDetailScroll = useCallback(
    (delta: number) => {
      setTaskDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  const backToAgents = useCallback(() => {
    setView('agents');
  }, []);

  const backToNews = useCallback(() => {
    setView('news');
  }, []);

  const moveDetailScroll = useCallback(
    (delta: number) => {
      setDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

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
        if (input === 't') return toggleTasksView();
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
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

      if (view === 'tasks') {
        if (input === 't') return toggleTasksView();
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (key.rightArrow) return openTaskDetail();
        if (key.tab) return cycleTeam(key.shift ? -1 : 1);
        if (key.upArrow) return moveTaskSel(-1);
        if (key.downArrow) return moveTaskSel(1);
        if (key.pageUp) return moveTaskSel(-tasksWindowSize);
        if (key.pageDown) return moveTaskSel(tasksWindowSize);
        if (isHomeKey(input)) return setTaskSelectedIndex(0);
        if (isEndKey(input)) return setTaskSelectedIndex(Math.max(0, tasksTotal - 1));
        return;
      }

      if (view === 'task-detail') {
        if (key.leftArrow || key.escape) return backToTasks();
        if (key.upArrow) return moveTaskDetailScroll(-1);
        if (key.downArrow) return moveTaskDetailScroll(1);
        if (key.pageUp) return moveTaskDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveTaskDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setTaskDetailScroll(0);
        if (isEndKey(input)) return setTaskDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'calendar') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'h') return openHeartbeats();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.upArrow) return moveSchedSel(-1);
        if (key.downArrow) return moveSchedSel(1);
        if (key.pageUp) return moveSchedSel(-calendarWindowSize);
        if (key.pageDown) return moveSchedSel(calendarWindowSize);
        if (isHomeKey(input)) return setSchedSelectedIndex(0);
        if (isEndKey(input)) return setSchedSelectedIndex(Math.max(0, schedTotal - 1));
        return;
      }

      if (view === 'heartbeats') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.tab) return cycleTeam(key.shift ? -1 : 1);
        if (key.upArrow) return moveHbSel(-1);
        if (key.downArrow) return moveHbSel(1);
        if (key.pageUp) return moveHbSel(-heartbeatsWindowSize);
        if (key.pageDown) return moveHbSel(heartbeatsWindowSize);
        if (isHomeKey(input)) return setHbSelectedIndex(0);
        if (isEndKey(input)) return setHbSelectedIndex(Math.max(0, hbTotal - 1));
        return;
      }

      if (view === 'news') {
        if (key.rightArrow) return openNewsDetail();
        if (key.leftArrow || key.escape) return backToAgents();
        if (key.upArrow) return moveNewsSel(-1);
        if (key.downArrow) return moveNewsSel(1);
        if (key.pageUp) return moveNewsSel(-newsWindowSize);
        if (key.pageDown) return moveNewsSel(newsWindowSize);
        if (isHomeKey(input)) return setNewsSelectedIndex(0);
        if (isEndKey(input)) return setNewsSelectedIndex(Math.max(0, newsTotal - 1));
        return;
      }

      // news-detail view
      if (key.leftArrow || key.escape) return backToNews();
      if (key.upArrow) return moveDetailScroll(-1);
      if (key.downArrow) return moveDetailScroll(1);
      if (key.pageUp) return moveDetailScroll(-detailWindowSize);
      if (key.pageDown) return moveDetailScroll(detailWindowSize);
      if (isHomeKey(input)) return setDetailScroll(0);
      if (isEndKey(input)) return setDetailScroll(Number.MAX_SAFE_INTEGER);
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
      ) : view === 'tasks' ? (
        <>
          <TeamsPanel
            teams={teams}
            selectedTeam={selectedTeam}
            allCount={allTasks.length}
            teamCounts={tasksTeamCounts}
          />
          <TasksTable
            tasks={visibleTasks}
            ageByName={ageByTaskName}
            selectedIndex={taskSelectedIndex}
            windowStart={taskWindowStart}
            windowSize={tasksWindowSize}
            loading={tasksPoll.lastUpdated === 0 && !tasksPoll.error && !staticMode}
            error={tasksPoll.error}
          />
        </>
      ) : view === 'calendar' ? (
        <CalendarView
          schedules={allSchedules}
          nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
          selectedIndex={schedSelectedIndex}
          windowStart={schedWindowStart}
          windowSize={calendarWindowSize}
          loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
          error={schedulesPoll.error}
        />
      ) : view === 'heartbeats' ? (
        <>
          <TeamsPanel
            teams={teams}
            selectedTeam={selectedTeam}
            allCount={heartbeatRows.length}
            teamCounts={heartbeatsTeamCounts}
          />
          <HeartbeatsView
            rows={visibleHeartbeats}
            nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
            selectedIndex={hbSelectedIndex}
            windowStart={hbWindowStart}
            windowSize={heartbeatsWindowSize}
            loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
            error={schedulesPoll.error}
          />
        </>
      ) : view === 'task-detail' ? (
        <TaskDetail
          task={visibleTasks[taskSelectedIndex] ?? null}
          positionLabel={
            tasksTotal > 0 ? `task ${taskSelectedIndex + 1} of ${tasksTotal}` : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={taskDetailScroll}
          contentWidth={DETAIL_CONTENT_WIDTH}
        />
      ) : view === 'news' ? (
        <NewsView
          agentName={selectedAgentName}
          items={sortedNewsItems}
          loading={newsPoll.lastUpdated === 0 && !newsPoll.error}
          error={newsPoll.error}
          windowStart={newsWindowStart}
          windowSize={newsWindowSize}
          selectedIndex={newsSelectedIndex}
          messageWidth={NEWS_MESSAGE_WIDTH}
          cooldownEpoch={cooldownEpoch}
        />
      ) : (
        <NewsDetail
          agentName={selectedAgentName}
          item={selectedNewsItem}
          positionLabel={
            selectedNewsItem && newsTotal > 0
              ? `item ${newsSelectedIndex + 1} of ${newsTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={detailScroll}
          contentWidth={DETAIL_CONTENT_WIDTH}
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
