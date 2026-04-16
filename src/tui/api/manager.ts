import type { Agent, AgentsResponse, Team, TeamsResponse } from './types.js';

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

export async function fetchAgentsByTeam(
  manager: string,
  team: string,
  signal: AbortSignal,
): Promise<Agent[]> {
  const url = `${manager}/agents?team=${encodeURIComponent(team)}`;
  const data = await getJson<AgentsResponse>(url, signal);
  return (data.agents ?? []).map((a) => ({ ...a, teamName: team }));
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
