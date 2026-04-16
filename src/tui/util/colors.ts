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
