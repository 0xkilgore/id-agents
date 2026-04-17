import type {
  Agent,
  AgentsResponse,
  NewsItem,
  RemoteNewsResponse,
  RemoteSchedulesResponse,
  RemoteTasksResponse,
  Schedule,
  Task,
  Team,
  TeamsResponse,
} from './types.js';

export function getManagerUrl(): string {
  return process.env.MANAGER_URL ?? 'http://localhost:4100';
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchTeams(manager: string, signal: AbortSignal): Promise<Team[]> {
  const data = await getJson<TeamsResponse>(`${manager}/teams`, signal);
  return (data.teams ?? []).filter((t) => t.name.toLowerCase() !== 'all');
}

function isRealAgent(a: Agent): boolean {
  return a.type !== 'interactive';
}

export async function fetchAgentsByTeam(
  manager: string,
  team: string,
  signal: AbortSignal,
): Promise<Agent[]> {
  const url = `${manager}/agents?team=${encodeURIComponent(team)}`;
  const data = await getJson<AgentsResponse>(url, signal);
  return (data.agents ?? [])
    .filter(isRealAgent)
    .map((a) => ({ ...a, teamName: team }));
}

export async function fetchTasks(
  manager: string,
  executor: string,
  signal: AbortSignal,
): Promise<Task[]> {
  const res = await fetch(`${manager}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: executor, command: '/task' }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`POST /remote → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RemoteTasksResponse;
  if (!data.ok) {
    throw new Error(data.error ?? 'unknown manager error');
  }
  return data.result?.tasks ?? [];
}

export async function fetchAgentNews(
  manager: string,
  executor: string,
  target: string,
  signal: AbortSignal,
): Promise<NewsItem[]> {
  const res = await fetch(`${manager}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: executor, command: `/news ${target}` }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`POST /remote → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RemoteNewsResponse;
  if (!data.ok) {
    throw new Error(data.error ?? 'unknown manager error');
  }
  return data.result?.items ?? [];
}

export async function fetchSchedulesForTeam(
  manager: string,
  executor: string,
  teamName: string,
  signal: AbortSignal,
): Promise<Schedule[]> {
  const res = await fetch(`${manager}/remote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-id-team': teamName,
    },
    body: JSON.stringify({ agent: executor, command: '/schedule list' }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`POST /remote → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RemoteSchedulesResponse;
  if (!data.ok) {
    throw new Error(data.error ?? 'unknown manager error');
  }
  const list = data.result?.schedules ?? [];
  return list.map((s) => ({ ...s, teamName }));
}

export async function fetchSchedulesAllTeams(
  manager: string,
  executor: string,
  teams: Team[],
  signal: AbortSignal,
): Promise<Schedule[]> {
  if (teams.length === 0) return [];
  const results = await Promise.all(
    teams.map((t) => fetchSchedulesForTeam(manager, executor, t.name, signal)),
  );
  const merged = new Map<string, Schedule>();
  for (const list of results) {
    for (const s of list) {
      if (!merged.has(s.id)) merged.set(s.id, s);
    }
  }
  return [...merged.values()];
}

export async function fetchAgentsAllTeams(
  manager: string,
  teams: Team[],
  signal: AbortSignal,
): Promise<Agent[]> {
  if (teams.length === 0) return [];
  const results = await Promise.all(
    teams.map((t) => fetchAgentsByTeam(manager, t.name, signal)),
  );
  const merged = new Map<string, Agent>();
  for (const list of results) {
    for (const agent of list) {
      if (!merged.has(agent.id)) merged.set(agent.id, agent);
    }
  }
  return [...merged.values()];
}
