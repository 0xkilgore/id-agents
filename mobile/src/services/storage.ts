import * as SecureStore from 'expo-secure-store';
import { ServerEntry } from '../types';

const SERVERS_KEY = 'id_agents_servers';
const CURRENT_SERVER_KEY = 'id_agents_current_server';

/**
 * Save a server entry (API key stored securely)
 */
export async function saveServer(server: ServerEntry): Promise<void> {
  const servers = await getServers();
  // Update existing or add new
  const idx = servers.findIndex((s) => s.name === server.name);
  if (idx >= 0) {
    servers[idx] = server;
  } else {
    servers.push(server);
  }
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
}

/**
 * Get all saved servers
 */
export async function getServers(): Promise<ServerEntry[]> {
  const raw = await SecureStore.getItemAsync(SERVERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Delete a saved server by name
 */
export async function deleteServer(name: string): Promise<void> {
  const servers = await getServers();
  const filtered = servers.filter((s) => s.name !== name);
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(filtered));

  // If deleted the current server, clear current
  const current = await getCurrentServerName();
  if (current === name) {
    await SecureStore.deleteItemAsync(CURRENT_SERVER_KEY);
  }
}

/**
 * Set the current active server name
 */
export async function setCurrentServer(name: string): Promise<void> {
  await SecureStore.setItemAsync(CURRENT_SERVER_KEY, name);
}

/**
 * Get the current active server name
 */
export async function getCurrentServerName(): Promise<string | null> {
  return await SecureStore.getItemAsync(CURRENT_SERVER_KEY);
}

/**
 * Get the current active server entry
 */
export async function getCurrentServer(): Promise<ServerEntry | null> {
  const name = await getCurrentServerName();
  if (!name) return null;
  const servers = await getServers();
  return servers.find((s) => s.name === name) || null;
}
