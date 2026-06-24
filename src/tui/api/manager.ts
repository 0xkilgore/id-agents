import type {
  Agent,
  AgentDetailResponse,
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
import type { EnqueueDispatchBody } from './dispatch-compose.js';

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
  teamName?: string,
): Promise<NewsItem[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (teamName) headers['x-id-team'] = teamName;
  const res = await fetch(`${manager}/remote`, {
    method: 'POST',
    headers,
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

export async function fetchLatestNewsTs(
  manager: string,
  executor: string,
  targetName: string,
  signal: AbortSignal,
  teamName?: string,
): Promise<number | null> {
  const items = await fetchAgentNews(manager, executor, targetName, signal, teamName);
  if (items.length === 0) return null;
  let max = 0;
  for (const it of items) if (it.timestamp > max) max = it.timestamp;
  return max > 0 ? max : null;
}

export async function fetchAgentsLatestNewsTs(
  manager: string,
  executor: string,
  agents: Agent[],
  signal: AbortSignal,
): Promise<Map<string, number | null>> {
  if (agents.length === 0) return new Map();
  const results = await Promise.all(
    agents.map(async (a) => {
      try {
        const ts = await fetchLatestNewsTs(manager, executor, a.name, signal, a.teamName);
        return [a.id, ts] as const;
      } catch {
        return [a.id, null] as const;
      }
    }),
  );
  return new Map(results);
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

/* ------------------------------------------------------------------ */
/*  Slice 8: library inventory (manager /library/* endpoints)          */
/* ------------------------------------------------------------------ */

export type LibraryAgentShape = 'claude-native' | 'agents-md-native';

export interface LibraryAgentRow {
  name: string;
  shape: LibraryAgentShape;
  hasReadme: boolean;
  hasLicense: boolean;
  subfolders: string[];
  source_path: string;
}

export interface LibraryAgentListResponse {
  libraryRoot: string | null;
  entries: LibraryAgentRow[];
  errors: Array<{ name: string; code: string; message: string }>;
}

export interface LibraryAgentDetailResponse extends LibraryAgentRow {
  memoryFile: string;
  readme: string | null;
  memory: string;
  bundledSkills: string[];
}

export interface LibrarySkillRow {
  name: string;
  hasSkillMd: boolean;
  source_path: string;
}

export interface LibrarySkillListResponse {
  libraryRoot: string | null;
  entries: LibrarySkillRow[];
}

export interface LibrarySkillDetailResponse extends LibrarySkillRow {
  skillFile: string;
  skillName: string | null;
  description: string | null;
  bodyLength: number;
}

export async function fetchLibraryAgents(
  manager: string,
  signal: AbortSignal,
): Promise<LibraryAgentListResponse> {
  return getJson<LibraryAgentListResponse>(`${manager}/library/agents`, signal);
}

export async function fetchLibraryAgent(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<LibraryAgentDetailResponse | null> {
  const res = await fetch(`${manager}/library/agents/${encodeURIComponent(name)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /library/agents/${name} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as LibraryAgentDetailResponse;
}

export async function fetchLibrarySkills(
  manager: string,
  signal: AbortSignal,
): Promise<LibrarySkillListResponse> {
  return getJson<LibrarySkillListResponse>(`${manager}/library/skills`, signal);
}

// Agent detail v2 (T-CKPT.agent-v2): per-agent charts + recent-output feed +
// skills/loops/scripts. 404 → null so the page falls back to the v1 fields.
export async function fetchAgentDetail(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<AgentDetailResponse | null> {
  const res = await fetch(`${manager}/agents/${encodeURIComponent(name)}/detail`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /agents/${name}/detail → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as AgentDetailResponse;
}

// AP8 (AGENT-V2): the agent-detail "dispatch to this agent" composer POSTs the
// shaped body (see buildAgentDispatchRequest) to the manager's enqueue route.
// Surfaces the manager's typed { ok:false, error } as a thrown Error so the
// composer can show it inline.
export interface EnqueueDispatchResponse {
  ok: true;
  dispatch_id?: string;
  query_id?: string;
  [k: string]: unknown;
}

export async function enqueueAgentDispatch(
  manager: string,
  body: EnqueueDispatchBody,
  signal?: AbortSignal,
): Promise<EnqueueDispatchResponse> {
  const res = await fetch(`${manager}/dispatch/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body — fall through to status-based error below */
  }
  if (!res.ok || data.ok === false) {
    const err = typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`;
    throw new Error(err);
  }
  return data as EnqueueDispatchResponse;
}

export async function fetchLibrarySkill(
  manager: string,
  name: string,
  signal: AbortSignal,
): Promise<LibrarySkillDetailResponse | null> {
  const res = await fetch(`${manager}/library/skills/${encodeURIComponent(name)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /library/skills/${name} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as LibrarySkillDetailResponse;
}
