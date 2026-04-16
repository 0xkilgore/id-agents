import type {
  Agent,
  AgentsResponse,
  NewsItem,
  RemoteNewsResponse,
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
