import { OutputLine, WsMessage, RemoteResponse } from '../types';

let lineCounter = 0;

function nextId(): string {
  return `line-${++lineCounter}`;
}

/**
 * Format a command being sent
 */
export function formatCommand(command: string): OutputLine {
  return {
    id: nextId(),
    text: `> ${command}`,
    type: 'command',
    timestamp: Date.now(),
  };
}

/**
 * Format a remote response into output lines
 */
export function formatResponse(response: RemoteResponse): OutputLine[] {
  const lines: OutputLine[] = [];

  if (response.error) {
    lines.push({
      id: nextId(),
      text: `Error: ${response.error}`,
      type: 'error',
      timestamp: Date.now(),
    });
    return lines;
  }

  const result = response.result;
  if (result === undefined || result === null) {
    lines.push({
      id: nextId(),
      text: 'OK',
      type: 'result',
      timestamp: Date.now(),
    });
    return lines;
  }

  // Handle string results
  if (typeof result === 'string') {
    for (const line of result.split('\n')) {
      lines.push({
        id: nextId(),
        text: line,
        type: 'result',
        timestamp: Date.now(),
      });
    }
    return lines;
  }

  // Handle object/array results - format as readable text
  if (typeof result === 'object') {
    const formatted = formatObject(result);
    for (const line of formatted.split('\n')) {
      lines.push({
        id: nextId(),
        text: line,
        type: 'result',
        timestamp: Date.now(),
      });
    }
    return lines;
  }

  // Fallback
  lines.push({
    id: nextId(),
    text: String(result),
    type: 'result',
    timestamp: Date.now(),
  });

  return lines;
}

/**
 * Format a WebSocket news message into an output line
 */
export function formatWsNews(message: WsMessage): OutputLine | null {
  const { newsType, from, message: text } = message;

  // Skip noisy status types
  if (
    newsType === 'query.received' ||
    newsType === 'pong' ||
    newsType === 'query.tool_use'
  ) {
    return null;
  }

  let prefix = from ? `[${from}]` : '';

  if (newsType === 'reply') {
    return {
      id: nextId(),
      text: `${prefix} ${text || ''}`.trim(),
      type: 'ws-news',
      timestamp: Date.now(),
    };
  }

  if (newsType === 'message') {
    return {
      id: nextId(),
      text: `${prefix} ${text || ''}`.trim(),
      type: 'ws-news',
      timestamp: Date.now(),
    };
  }

  if (newsType === 'query.completed') {
    const resultPreview = message.data?.result?.result?.substring(0, 200) || '';
    return {
      id: nextId(),
      text: `${prefix} Completed${resultPreview ? `: ${resultPreview}` : ''}`,
      type: 'info',
      timestamp: Date.now(),
    };
  }

  if (newsType === 'query.failed') {
    return {
      id: nextId(),
      text: `${prefix} Failed: ${message.data?.error || 'Unknown error'}`,
      type: 'error',
      timestamp: Date.now(),
    };
  }

  if (newsType === 'query.progress') {
    return {
      id: nextId(),
      text: `${prefix} ${text || message.data?.content || ''}`.trim(),
      type: 'info',
      timestamp: Date.now(),
    };
  }

  // Show other message/outbound types
  if (newsType && (newsType.startsWith('outbound.') || newsType.startsWith('query.'))) {
    return {
      id: nextId(),
      text: `${prefix} ${newsType}: ${text || ''}`.trim(),
      type: 'info',
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Create a system message line
 */
export function systemLine(text: string): OutputLine {
  return {
    id: nextId(),
    text,
    type: 'system',
    timestamp: Date.now(),
  };
}

/**
 * Format an object into readable text (for agent lists, status, etc.)
 */
function formatObject(obj: any, indent = 0): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '(empty)';

    // If array of objects with name/alias fields, format as table-like
    if (obj[0] && typeof obj[0] === 'object' && (obj[0].name || obj[0].alias)) {
      return obj
        .map((item: any) => {
          const name = item.displayId || item.name || item.alias || '?';
          const status = item.status || '';
          const type = item.type || '';
          const pad = ' '.repeat(indent);
          return `${pad}${name}  ${status}  ${type}`;
        })
        .join('\n');
    }

    return obj
      .map((item: any) =>
        typeof item === 'object'
          ? formatObject(item, indent + 2)
          : `${' '.repeat(indent)}${item}`
      )
      .join('\n');
  }

  // Single object
  const pad = ' '.repeat(indent);
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (typeof v === 'object') {
        return `${pad}${k}:\n${formatObject(v, indent + 2)}`;
      }
      return `${pad}${k}: ${v}`;
    })
    .join('\n');
}
