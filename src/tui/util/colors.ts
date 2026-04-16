export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'green';
    case 'offline':
      return 'red';
    case 'starting':
    case 'stopping':
      return 'yellow';
    default:
      return 'gray';
  }
}

export function healthColor(health: string): string {
  return health === 'online' ? 'green' : health === 'offline' ? 'red' : 'gray';
}

export function healthDot(health: string): string {
  return health === 'online' ? '●' : '○';
}

/**
 * Age-based color for a news item. Derived purely from the item's timestamp
 * and a shared cooldown epoch (updated on a 10-second tick by App), never
 * from a free-running Date.now() inside render. Bands are discrete so output
 * is byte-stable within each band.
 */
export function newsAgeColor(timestampMs: number, cooldownEpochMs: number): string {
  const ageSec = Math.max(0, Math.floor((cooldownEpochMs - timestampMs) / 1000));
  if (ageSec < 60) return 'greenBright';
  if (ageSec < 300) return 'green';
  if (ageSec < 900) return 'yellow';
  return 'gray';
}
