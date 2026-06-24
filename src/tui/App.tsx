import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Footer } from './components/Footer.js';
import { HelpModal } from './components/HelpModal.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AgentsTable } from './components/AgentsTable.js';
import { NewsView } from './components/NewsView.js';
import { NewsDetail } from './components/NewsDetail.js';
import { StatusStrip } from './components/StatusStrip.js';
import { TasksTable } from './components/TasksTable.js';
import { TaskDetail } from './components/TaskDetail.js';
import { CalendarView } from './components/CalendarView.js';
import { HeartbeatsView, type HeartbeatRow } from './components/HeartbeatsView.js';
import { HeartbeatDetail } from './components/HeartbeatDetail.js';
import { AgentDetail } from './components/AgentDetail.js';
import { LibraryAgentsTable } from './components/LibraryAgentsTable.js';
import { LibraryAgentDetail } from './components/LibraryAgentDetail.js';
import { LibrarySkillsTable } from './components/LibrarySkillsTable.js';
import { LibrarySkillDetail } from './components/LibrarySkillDetail.js';
import type { Agent, AgentDetailResponse, NewsItem, Schedule, Task, Team } from './api/types.js';
import {
  fetchAgentDetail,
  fetchAgentNews,
  fetchAgentsAllTeams,
  fetchAgentsLatestNewsTs,
  fetchLibraryAgent,
  fetchLibraryAgents,
  fetchLibrarySkill,
  fetchLibrarySkills,
  fetchSchedulesAllTeams,
  fetchTasks,
  fetchTeams,
  getManagerUrl,
  type LibraryAgentDetailResponse,
  type LibraryAgentListResponse,
  type LibrarySkillDetailResponse,
  type LibrarySkillListResponse,
} from './api/manager.js';
import { usePolling } from './hooks/usePolling.js';
import { humanizeUptime } from './util/format.js';
import { newsAgeColor } from './util/colors.js';
import {
  fetchRssForPids,
  formatTotalMemory,
  totalMemoryColor as totalMemColor,
} from './util/memory.js';

type View =
  | 'agents'
  | 'agent-detail'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail'
  | 'library-agents'
  | 'library-agent-detail'
  | 'library-skills'
  | 'library-skill-detail';

const AGENTS_POLL_MS = 2000;
const TEAMS_POLL_MS = 15000;
const NEWS_POLL_MS = 3000;
const TASKS_POLL_MS = 5000;
const SCHEDULES_POLL_MS = 5000;
const LIBRARY_POLL_MS = 5000;
const NEWS_COOLDOWN_TICK_MS = 10_000;
const AGENTS_CHROME_ROWS = 11;
const NEWS_CHROME_ROWS = 6;
const DETAIL_CHROME_ROWS = 6;
const TASKS_CHROME_ROWS = 10;
// Calendar: no TeamsPanel, no StatusStrip — only the bordered list box
// (border 2 + title 1 + header 1 + above-arrow 1 + body windowSize +
// below-arrow 1 = windowSize + 6) and the footer (1). Off-by-one here
// causes the list to overflow the terminal height and the terminal to
// scroll up on every redraw, leaking the previous frame's chrome.
const CALENDAR_CHROME_ROWS = 7;
// Heartbeats: no TeamsPanel, no StatusStrip — bordered list box
// (windowSize + 6) + footer (1) = 7. Matches Calendar.
const HEARTBEATS_CHROME_ROWS = 7;
// Library tables include a one-line subtitle (the libraryRoot path) on top
// of the standard list-box chrome, so they need 1 extra row vs Heartbeats.
const LIBRARY_CHROME_ROWS = 8;
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
  const [libAgentSelectedIndex, setLibAgentSelectedIndex] = useState(0);
  const [libAgentWindowStart, setLibAgentWindowStart] = useState(0);
  const [libSkillSelectedIndex, setLibSkillSelectedIndex] = useState(0);
  const [libSkillWindowStart, setLibSkillWindowStart] = useState(0);
  const [libAgentDetailScroll, setLibAgentDetailScroll] = useState(0);
  const [libSkillDetailScroll, setLibSkillDetailScroll] = useState(0);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cooldownEpoch, setCooldownEpoch] = useState<number>(() => Date.now());

  // Cooldown tick runs on news AND agents so the news-freshness dot in
  // the agents table colours against the same 10s epoch rather than a
  // free-running clock. Bucketed colour thresholds mean re-renders only
  // fire when an item crosses a 60/300/900s band.
  useEffect(() => {
    const needsTick = view === 'news' || view === 'agents';
    if (!needsTick || staticMode) return;
    setCooldownEpoch(Date.now());
    const id = setInterval(() => setCooldownEpoch(Date.now()), NEWS_COOLDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [view, staticMode]);

  const teamsPoll = usePolling<Team[]>(
    (signal) => fetchTeams(manager, signal),
    TEAMS_POLL_MS,
    staticMode,
    [manager],
  );
  const teamsRaw = staticMode ? staticTeams ?? [] : teamsPoll.data ?? [];
  // Always render `public` immediately after the `All` chip, then the rest in
  // the order the manager returned them. Keeps the public team a stable
  // anchor as new teams are added.
  const teams = useMemo(() => {
    const pub = teamsRaw.filter((t) => t.name === 'public');
    const rest = teamsRaw.filter((t) => t.name !== 'public');
    return [...pub, ...rest];
  }, [teamsRaw]);

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
    staticMode,
    [manager, teams.length],
  );
  const allAgents = staticMode ? staticAllAgents ?? [] : agentsPoll.data ?? [];

  // Per-agent news freshness — one batched fan-out per agents-poll cycle,
  // gated to the agents view so other views don't pay the cost.
  const newsFreshnessFetcher = useCallback(
    (signal: AbortSignal): Promise<Array<[string, number | null]>> => {
      if (allAgents.length === 0) return Promise.resolve([]);
      return fetchAgentsLatestNewsTs(manager, SELF_AGENT, allAgents, signal).then((m) => [
        ...m.entries(),
      ]);
    },
    [manager, allAgents],
  );
  const newsFreshnessPoll = usePolling<Array<[string, number | null]>>(
    newsFreshnessFetcher,
    AGENTS_POLL_MS,
    staticMode || view !== 'agents',
    [manager, allAgents.length, view],
  );
  const latestNewsTsById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [id, ts] of newsFreshnessPoll.data ?? []) m.set(id, ts);
    return m;
  }, [newsFreshnessPoll.data]);
  const newsColorById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents) {
      const ts = latestNewsTsById.get(a.id) ?? null;
      m.set(a.id, ts == null ? 'gray' : newsAgeColor(ts, cooldownEpoch));
    }
    return m;
  }, [allAgents, latestNewsTsById, cooldownEpoch]);

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

  // Per-agent memory — one batched `ps` call per poll tick. Pids come from
  // agent metadata persisted by the manager at spawn time; agents without a
  // pid (or whose pid is gone) render `—`. Gated to the agents view so we
  // don't fork ps when nothing is looking.
  const pidByAgentId = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allAgents) {
      const pid = (a.metadata as { pid?: unknown } | undefined)?.pid;
      if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
        map.set(a.id, pid);
      }
    }
    return map;
  }, [allAgents]);

  const memoryFetcher = useCallback(
    (signal: AbortSignal): Promise<Array<[string, number | null]>> => {
      const pids = [...pidByAgentId.values()];
      if (pids.length === 0) return Promise.resolve([]);
      return fetchRssForPids(pids, signal).then((rssByPid) => {
        const out: Array<[string, number | null]> = [];
        for (const [agentId, pid] of pidByAgentId) {
          const bytes = rssByPid.get(pid);
          out.push([agentId, bytes ?? null]);
        }
        return out;
      });
    },
    [pidByAgentId],
  );
  const memoryPoll = usePolling<Array<[string, number | null]>>(
    memoryFetcher,
    AGENTS_POLL_MS,
    staticMode || view !== 'agents',
    [pidByAgentId, view],
  );
  const memBytesById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [id, bytes] of memoryPoll.data ?? []) m.set(id, bytes);
    return m;
  }, [memoryPoll.data]);
  // Only local agents contribute to total memory — remote agents have no
  // RSS. Build a set of local agent IDs so the sum excludes remote rows.
  const localAgentIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of allAgents) {
      const isRemote = a.deploymentShape === 'remote-endpoint' ||
        a.metadata?.runtime === 'public-agent-remote';
      if (!isRemote) s.add(a.id);
    }
    return s;
  }, [allAgents]);

  const totalMemoryBytes = useMemo(() => {
    let sum = 0;
    for (const [id, bytes] of memBytesById) {
      if (!localAgentIds.has(id)) continue;
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) sum += bytes;
    }
    return sum;
  }, [memBytesById, localAgentIds]);
  const totalMemoryLabel = useMemo(() => formatTotalMemory(totalMemoryBytes), [totalMemoryBytes]);
  const totalMemoryColor = useMemo(() => totalMemColor(totalMemoryBytes), [totalMemoryBytes]);

  const rows = stdout?.rows ?? 30;
  const agentsWindowSize = Math.max(MIN_VISIBLE, rows - AGENTS_CHROME_ROWS);
  const newsWindowSize = Math.max(MIN_VISIBLE, rows - NEWS_CHROME_ROWS);
  const detailWindowSize = Math.max(MIN_VISIBLE, rows - DETAIL_CHROME_ROWS);
  const tasksWindowSize = Math.max(MIN_VISIBLE, rows - TASKS_CHROME_ROWS);
  const calendarWindowSize = Math.max(MIN_VISIBLE, rows - CALENDAR_CHROME_ROWS);
  const heartbeatsWindowSize = Math.max(MIN_VISIBLE, rows - HEARTBEATS_CHROME_ROWS);
  const libraryWindowSize = Math.max(MIN_VISIBLE, rows - LIBRARY_CHROME_ROWS);
  const total = visibleAgents.length;

  // Tasks polling
  const tasksFetcher = useCallback(
    (signal: AbortSignal): Promise<Task[]> => fetchTasks(manager, SELF_AGENT, signal),
    [manager],
  );
  const tasksPoll = usePolling<Task[]>(
    tasksFetcher,
    TASKS_POLL_MS,
    staticMode || (view !== 'tasks' && view !== 'task-detail'),
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
    staticMode || (view !== 'calendar' && view !== 'heartbeats'),
    [manager, teams.length, view],
  );
  const allSchedules = schedulesPoll.data ?? [];
  // Calendar excludes heartbeat-kind schedules — those already appear on
  // the Heartbeats page, so duplicating them here just adds noise.
  const calendarSchedules = useMemo(
    () =>
      allSchedules.filter(
        (s) => s.kind !== 'heartbeat' && !/^Heartbeat:\s/i.test(s.title),
      ),
    [allSchedules],
  );
  const schedTotal = calendarSchedules.length;

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

  // Heartbeats is a cross-team view, same shape as Calendar — no team
  // filter or TeamsPanel chrome. See Calendar: drop top teams-chips bar.
  const hbTotal = heartbeatRows.length;

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
  const selectedAgentTeam: string | null = selectedAgent?.teamName ?? null;

  const newsFetcher = useCallback(
    (signal: AbortSignal): Promise<NewsItem[]> => {
      if (!selectedAgentName) return Promise.resolve([]);
      return fetchAgentNews(manager, SELF_AGENT, selectedAgentName, signal, selectedAgentTeam ?? undefined);
    },
    [manager, selectedAgentName, selectedAgentTeam],
  );

  const newsPoll = usePolling<NewsItem[]>(
    newsFetcher,
    NEWS_POLL_MS,
    staticMode || (view !== 'news' && view !== 'news-detail'),
    [manager, selectedAgentName ?? '', selectedAgentTeam ?? '', view],
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
  const [hbDetailScroll, setHbDetailScroll] = useState(0);
  const [agentDetailScroll, setAgentDetailScroll] = useState(0);

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

  const openHeartbeatDetail = useCallback(() => {
    setHbDetailScroll(0);
    setView('heartbeat-detail');
  }, []);

  const backToHeartbeats = useCallback(() => {
    setView('heartbeats');
  }, []);

  const moveHbDetailScroll = useCallback(
    (delta: number) => {
      setHbDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
  );

  const moveHbSel = useCallback(
    (delta: number) => {
      if (hbTotal === 0) return;
      setHbSelectedIndex((idx) => clamp(idx + delta, 0, hbTotal - 1));
    },
    [hbTotal],
  );

  const openAgentDetail = useCallback(() => {
    if (!selectedAgent) return;
    const isRemote = selectedAgent.deploymentShape === 'remote-endpoint' ||
      selectedAgent.metadata?.runtime === 'public-agent-remote';
    if (!isRemote) return; // local agents drill into news instead
    setAgentDetailScroll(0);
    setView('agent-detail');
  }, [selectedAgent]);

  const backFromAgentDetail = useCallback(() => {
    setView('agents');
  }, []);

  const moveAgentDetailScroll = useCallback(
    (delta: number) => {
      setAgentDetailScroll((off) => Math.max(0, off + delta));
    },
    [],
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

  // ---------------------------------------------------------------- Library
  // Read-only browser fed by slice-7 manager /library/* endpoints. No
  // filesystem access from the TUI; cadence matches TasksTable.
  const libraryAgentsFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryAgentListResponse> =>
      fetchLibraryAgents(manager, signal),
    [manager],
  );
  const libraryAgentsPoll = usePolling<LibraryAgentListResponse>(
    libraryAgentsFetcher,
    LIBRARY_POLL_MS,
    staticMode || (view !== 'library-agents' && view !== 'library-agent-detail'),
    [manager, view],
  );
  const libraryAgentRows = libraryAgentsPoll.data?.entries ?? [];
  const libraryAgentRoot = libraryAgentsPoll.data?.libraryRoot ?? null;
  const libraryAgentErrors = libraryAgentsPoll.data?.errors ?? [];
  const libraryAgentTotal = libraryAgentRows.length;
  const selectedLibraryAgentName = libraryAgentRows[libAgentSelectedIndex]?.name ?? null;

  const librarySkillsFetcher = useCallback(
    (signal: AbortSignal): Promise<LibrarySkillListResponse> =>
      fetchLibrarySkills(manager, signal),
    [manager],
  );
  const librarySkillsPoll = usePolling<LibrarySkillListResponse>(
    librarySkillsFetcher,
    LIBRARY_POLL_MS,
    staticMode || (view !== 'library-skills' && view !== 'library-skill-detail'),
    [manager, view],
  );
  const librarySkillRows = librarySkillsPoll.data?.entries ?? [];
  const librarySkillRoot = librarySkillsPoll.data?.libraryRoot ?? null;
  const librarySkillTotal = librarySkillRows.length;
  const selectedLibrarySkillName = librarySkillRows[libSkillSelectedIndex]?.name ?? null;

  const libraryAgentDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<LibraryAgentDetailResponse | null> => {
      if (!selectedLibraryAgentName) return Promise.resolve(null);
      return fetchLibraryAgent(manager, selectedLibraryAgentName, signal);
    },
    [manager, selectedLibraryAgentName],
  );
  const libraryAgentDetailPoll = usePolling<LibraryAgentDetailResponse | null>(
    libraryAgentDetailFetcher,
    LIBRARY_POLL_MS,
    staticMode || view !== 'library-agent-detail' || !selectedLibraryAgentName,
    [manager, selectedLibraryAgentName ?? '', view],
  );

  // Agent dossier v2 (T-CKPT.agent-v2) — charts + recent-output-20 +
  // skills/loops/scripts for the focused agent. Only polls in the detail view.
  const agentDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<AgentDetailResponse | null> => {
      if (!selectedAgentName) return Promise.resolve(null);
      return fetchAgentDetail(manager, selectedAgentName, signal);
    },
    [manager, selectedAgentName],
  );
  const agentDetailPoll = usePolling<AgentDetailResponse | null>(
    agentDetailFetcher,
    AGENTS_POLL_MS,
    staticMode || view !== 'agent-detail' || !selectedAgentName,
    [manager, selectedAgentName ?? '', view],
  );

  const librarySkillDetailFetcher = useCallback(
    (signal: AbortSignal): Promise<LibrarySkillDetailResponse | null> => {
      if (!selectedLibrarySkillName) return Promise.resolve(null);
      return fetchLibrarySkill(manager, selectedLibrarySkillName, signal);
    },
    [manager, selectedLibrarySkillName],
  );
  const librarySkillDetailPoll = usePolling<LibrarySkillDetailResponse | null>(
    librarySkillDetailFetcher,
    LIBRARY_POLL_MS,
    staticMode || view !== 'library-skill-detail' || !selectedLibrarySkillName,
    [manager, selectedLibrarySkillName ?? '', view],
  );

  // Window/selection clamping for the two library list views, matching the
  // pattern used by tasks/heartbeats above.
  useEffect(() => {
    if (libraryAgentTotal === 0) {
      if (libAgentSelectedIndex !== 0) setLibAgentSelectedIndex(0);
      if (libAgentWindowStart !== 0) setLibAgentWindowStart(0);
      return;
    }
    const clampedSel = Math.min(libAgentSelectedIndex, libraryAgentTotal - 1);
    if (clampedSel !== libAgentSelectedIndex) setLibAgentSelectedIndex(clampedSel);
    const maxStart = Math.max(0, libraryAgentTotal - libraryWindowSize);
    let nextStart = libAgentWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + libraryWindowSize)
      nextStart = clampedSel - libraryWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== libAgentWindowStart) setLibAgentWindowStart(nextStart);
  }, [libraryAgentTotal, libAgentSelectedIndex, libAgentWindowStart, libraryWindowSize]);

  useEffect(() => {
    if (librarySkillTotal === 0) {
      if (libSkillSelectedIndex !== 0) setLibSkillSelectedIndex(0);
      if (libSkillWindowStart !== 0) setLibSkillWindowStart(0);
      return;
    }
    const clampedSel = Math.min(libSkillSelectedIndex, librarySkillTotal - 1);
    if (clampedSel !== libSkillSelectedIndex) setLibSkillSelectedIndex(clampedSel);
    const maxStart = Math.max(0, librarySkillTotal - libraryWindowSize);
    let nextStart = libSkillWindowStart;
    if (clampedSel < nextStart) nextStart = clampedSel;
    if (clampedSel >= nextStart + libraryWindowSize)
      nextStart = clampedSel - libraryWindowSize + 1;
    if (nextStart > maxStart) nextStart = maxStart;
    if (nextStart < 0) nextStart = 0;
    if (nextStart !== libSkillWindowStart) setLibSkillWindowStart(nextStart);
  }, [librarySkillTotal, libSkillSelectedIndex, libSkillWindowStart, libraryWindowSize]);

  const moveLibraryAgentSel = useCallback(
    (delta: number) => {
      if (libraryAgentTotal === 0) return;
      setLibAgentSelectedIndex((idx) => clamp(idx + delta, 0, libraryAgentTotal - 1));
    },
    [libraryAgentTotal],
  );

  const moveLibrarySkillSel = useCallback(
    (delta: number) => {
      if (librarySkillTotal === 0) return;
      setLibSkillSelectedIndex((idx) => clamp(idx + delta, 0, librarySkillTotal - 1));
    },
    [librarySkillTotal],
  );

  const openLibraryAgents = useCallback(() => {
    setLibAgentSelectedIndex(0);
    setLibAgentWindowStart(0);
    setView('library-agents');
  }, []);

  const openLibrarySkills = useCallback(() => {
    setLibSkillSelectedIndex(0);
    setLibSkillWindowStart(0);
    setView('library-skills');
  }, []);

  const openLibraryAgentDetail = useCallback(() => {
    if (!selectedLibraryAgentName) return;
    setLibAgentDetailScroll(0);
    setView('library-agent-detail');
  }, [selectedLibraryAgentName]);

  const openLibrarySkillDetail = useCallback(() => {
    if (!selectedLibrarySkillName) return;
    setLibSkillDetailScroll(0);
    setView('library-skill-detail');
  }, [selectedLibrarySkillName]);

  const moveLibraryAgentDetailScroll = useCallback((delta: number) => {
    setLibAgentDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  const moveLibrarySkillDetailScroll = useCallback((delta: number) => {
    setLibSkillDetailScroll((off) => Math.max(0, off + delta));
  }, []);

  useInput(
    (input, key) => {
      // Quit confirmation — intercepts q when not yet confirmed. Ctrl-C still
      // exits immediately (users who want a hard quit have it). Inside the
      // confirmation, Enter / y commits, Esc / n cancels.
      if (showQuitConfirm) {
        if (key.return || input === 'y' || input === 'Y') {
          exit();
          return;
        }
        if (key.escape || input === 'n' || input === 'N' || (key.ctrl && input === 'c')) {
          setShowQuitConfirm(false);
          return;
        }
        return; // swallow everything else while the dialog is open
      }
      // Help modal — intercepts all keys so navigation while help is open
      // can't accidentally drive the underlying view. ? toggles, Esc closes,
      // and any arrow key also closes (so the user can return to navigating
      // their previous view without thinking).
      if (showHelp) {
        if (
          input === '?' ||
          key.escape ||
          key.upArrow ||
          key.downArrow ||
          key.leftArrow ||
          key.rightArrow
        ) {
          setShowHelp(false);
          return;
        }
        if (key.ctrl && input === 'c') {
          exit();
          return;
        }
        return; // swallow everything else
      }
      // global
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }
      if (input === 'q') {
        setShowQuitConfirm(true);
        return;
      }
      if (input === '?') {
        setShowHelp(true);
        return;
      }
      if (view === 'agents') {
        if (input === 't') return toggleTasksView();
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.rightArrow) {
          // Remote agents get the detail panel; local agents get news
          const isRemote = selectedAgent?.deploymentShape === 'remote-endpoint' ||
            selectedAgent?.metadata?.runtime === 'public-agent-remote';
          return isRemote ? openAgentDetail() : openNews();
        }
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
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.leftArrow || key.escape) return setView('agents');
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
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.upArrow) return moveSchedSel(-1);
        if (key.downArrow) return moveSchedSel(1);
        if (key.pageUp) return moveSchedSel(-calendarWindowSize);
        if (key.pageDown) return moveSchedSel(calendarWindowSize);
        if (isHomeKey(input)) return setSchedSelectedIndex(0);
        if (isEndKey(input)) return setSchedSelectedIndex(Math.max(0, schedTotal - 1));
        return;
      }

      if (view === 'agent-detail') {
        if (key.leftArrow || key.escape) return backFromAgentDetail();
        if (key.upArrow) return moveAgentDetailScroll(-1);
        if (key.downArrow) return moveAgentDetailScroll(1);
        if (key.pageUp) return moveAgentDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveAgentDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setAgentDetailScroll(0);
        if (isEndKey(input)) return setAgentDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'heartbeats') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'l') return openLibraryAgents();
        if (input === 's') return openLibrarySkills();
        if (key.rightArrow) return openHeartbeatDetail();
        if (key.upArrow) return moveHbSel(-1);
        if (key.downArrow) return moveHbSel(1);
        if (key.pageUp) return moveHbSel(-heartbeatsWindowSize);
        if (key.pageDown) return moveHbSel(heartbeatsWindowSize);
        if (isHomeKey(input)) return setHbSelectedIndex(0);
        if (isEndKey(input)) return setHbSelectedIndex(Math.max(0, hbTotal - 1));
        return;
      }

      if (view === 'heartbeat-detail') {
        if (key.leftArrow || key.escape) return backToHeartbeats();
        if (key.upArrow) return moveHbDetailScroll(-1);
        if (key.downArrow) return moveHbDetailScroll(1);
        if (key.pageUp) return moveHbDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveHbDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setHbDetailScroll(0);
        if (isEndKey(input)) return setHbDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'library-agents') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 's') return openLibrarySkills();
        if (key.leftArrow || key.escape) return setView('agents');
        if (key.rightArrow) return openLibraryAgentDetail();
        if (key.upArrow) return moveLibraryAgentSel(-1);
        if (key.downArrow) return moveLibraryAgentSel(1);
        if (key.pageUp) return moveLibraryAgentSel(-libraryWindowSize);
        if (key.pageDown) return moveLibraryAgentSel(libraryWindowSize);
        if (isHomeKey(input)) return setLibAgentSelectedIndex(0);
        if (isEndKey(input)) return setLibAgentSelectedIndex(Math.max(0, libraryAgentTotal - 1));
        return;
      }

      if (view === 'library-agent-detail') {
        if (key.leftArrow || key.escape) return setView('library-agents');
        if (key.upArrow) return moveLibraryAgentDetailScroll(-1);
        if (key.downArrow) return moveLibraryAgentDetailScroll(1);
        if (key.pageUp) return moveLibraryAgentDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveLibraryAgentDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setLibAgentDetailScroll(0);
        if (isEndKey(input)) return setLibAgentDetailScroll(Number.MAX_SAFE_INTEGER);
        return;
      }

      if (view === 'library-skills') {
        if (input === 'a') return setView('agents');
        if (input === 't') return setView('tasks');
        if (input === 'c') return openCalendar();
        if (input === 'h') return openHeartbeats();
        if (input === 'l') return openLibraryAgents();
        if (key.leftArrow || key.escape) return openLibraryAgents();
        if (key.rightArrow) return openLibrarySkillDetail();
        if (key.upArrow) return moveLibrarySkillSel(-1);
        if (key.downArrow) return moveLibrarySkillSel(1);
        if (key.pageUp) return moveLibrarySkillSel(-libraryWindowSize);
        if (key.pageDown) return moveLibrarySkillSel(libraryWindowSize);
        if (isHomeKey(input)) return setLibSkillSelectedIndex(0);
        if (isEndKey(input)) return setLibSkillSelectedIndex(Math.max(0, librarySkillTotal - 1));
        return;
      }

      if (view === 'library-skill-detail') {
        if (key.leftArrow || key.escape) return setView('library-skills');
        if (key.upArrow) return moveLibrarySkillDetailScroll(-1);
        if (key.downArrow) return moveLibrarySkillDetailScroll(1);
        if (key.pageUp) return moveLibrarySkillDetailScroll(-detailWindowSize);
        if (key.pageDown) return moveLibrarySkillDetailScroll(detailWindowSize);
        if (isHomeKey(input)) return setLibSkillDetailScroll(0);
        if (isEndKey(input)) return setLibSkillDetailScroll(Number.MAX_SAFE_INTEGER);
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

  if (showHelp) {
    // Fill the terminal height so the modal overwrites any residual lines
    // from the previous view (otherwise the bottom of the agents table can
    // peek out below the modal). The flexGrow spacer pins the footer to the
    // last row even when the terminal is resized.
    const rows = stdout?.rows ?? 24;
    return (
      <Box flexDirection="column" height={rows}>
        <HelpModal />
        <Box flexGrow={1} />
        <Footer view={view} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showQuitConfirm ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Quit? </Text>
          <Text dimColor>Enter / y = yes   ·   Esc / n = no</Text>
        </Box>
      ) : null}
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
            newsColorById={newsColorById}
            memBytesById={memBytesById}
            totalMemoryLabel={totalMemoryLabel}
            totalMemoryColor={totalMemoryColor}
            selectedIndex={selectedIndex}
            windowStart={windowStart}
            windowSize={agentsWindowSize}
            loading={agentsPoll.lastUpdated === 0 && !agentsPoll.error && !staticMode}
            error={agentsPoll.error}
            nowMs={pollTs || Date.now()}
          />
          {teamsPoll.error ? (
            <Box paddingX={1}>
              <Text color="red">teams error: {teamsPoll.error.message}</Text>
            </Box>
          ) : null}
        </>
      ) : view === 'agent-detail' ? (
        <AgentDetail
          agent={selectedAgent}
          positionLabel={
            total > 0 ? `agent ${selectedIndex + 1} of ${total}` : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={agentDetailScroll}
          contentWidth={DETAIL_CONTENT_WIDTH}
          nowMs={pollTs || Date.now()}
          detail={agentDetailPoll.data ?? null}
        />
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
          schedules={calendarSchedules}
          nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
          selectedIndex={schedSelectedIndex}
          windowStart={schedWindowStart}
          windowSize={calendarWindowSize}
          loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
          error={schedulesPoll.error}
        />
      ) : view === 'heartbeats' ? (
        <HeartbeatsView
          rows={heartbeatRows}
          nowSec={Math.floor((schedulesPoll.lastUpdated || Date.now()) / 1000)}
          selectedIndex={hbSelectedIndex}
          windowStart={hbWindowStart}
          windowSize={heartbeatsWindowSize}
          loading={schedulesPoll.lastUpdated === 0 && !schedulesPoll.error && !staticMode}
          error={schedulesPoll.error}
        />
      ) : view === 'heartbeat-detail' ? (
        (() => {
          const sel = heartbeatRows[hbSelectedIndex];
          if (!sel) {
            return (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>heartbeat · (none selected)</Text>
                <Text dimColor> </Text>
                <Text dimColor>(no row selected — press ← to return)</Text>
                {Array.from({ length: Math.max(0, detailWindowSize - 1) }, (_, i) => (
                  <Text key={`pad-${i}`}> </Text>
                ))}
              </Box>
            );
          }
          const agent = allAgents.find((a) => a.name === sel.agent);
          return (
            <HeartbeatDetail
              agentName={sel.agent}
              workingDirectory={agent?.workingDirectory ?? null}
              intervalSec={sel.intervalSec}
              lastFireSec={sel.lastFireSec}
              nextFireSec={sel.nextFireSec}
              positionLabel={`agent ${hbSelectedIndex + 1} of ${hbTotal}`}
              windowSize={detailWindowSize}
              scrollOffset={hbDetailScroll}
              contentWidth={DETAIL_CONTENT_WIDTH}
            />
          );
        })()
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
      ) : view === 'library-agents' ? (
        <LibraryAgentsTable
          entries={libraryAgentRows}
          libraryRoot={libraryAgentRoot}
          errorCount={libraryAgentErrors.length}
          selectedIndex={libAgentSelectedIndex}
          windowStart={libAgentWindowStart}
          windowSize={libraryWindowSize}
          loading={libraryAgentsPoll.lastUpdated === 0 && !libraryAgentsPoll.error && !staticMode}
          error={libraryAgentsPoll.error}
        />
      ) : view === 'library-agent-detail' ? (
        <LibraryAgentDetail
          agent={libraryAgentDetailPoll.data ?? null}
          agentName={selectedLibraryAgentName}
          loading={
            libraryAgentDetailPoll.lastUpdated === 0 && !libraryAgentDetailPoll.error
          }
          error={libraryAgentDetailPoll.error}
          positionLabel={
            libraryAgentTotal > 0
              ? `agent ${libAgentSelectedIndex + 1} of ${libraryAgentTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={libAgentDetailScroll}
          contentWidth={DETAIL_CONTENT_WIDTH}
        />
      ) : view === 'library-skills' ? (
        <LibrarySkillsTable
          entries={librarySkillRows}
          libraryRoot={librarySkillRoot}
          selectedIndex={libSkillSelectedIndex}
          windowStart={libSkillWindowStart}
          windowSize={libraryWindowSize}
          loading={librarySkillsPoll.lastUpdated === 0 && !librarySkillsPoll.error && !staticMode}
          error={librarySkillsPoll.error}
        />
      ) : view === 'library-skill-detail' ? (
        <LibrarySkillDetail
          skill={librarySkillDetailPoll.data ?? null}
          skillName={selectedLibrarySkillName}
          loading={
            librarySkillDetailPoll.lastUpdated === 0 && !librarySkillDetailPoll.error
          }
          error={librarySkillDetailPoll.error}
          positionLabel={
            librarySkillTotal > 0
              ? `skill ${libSkillSelectedIndex + 1} of ${librarySkillTotal}`
              : ''
          }
          windowSize={detailWindowSize}
          scrollOffset={libSkillDetailScroll}
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
      <Footer view={view} />
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
