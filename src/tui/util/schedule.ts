import type { Schedule } from '../api/types.js';

const DAY_SECONDS = 86400;

export function cadenceLabel(s: Schedule): string {
  if (s.kind === 'heartbeat' && s.intervalSeconds && s.intervalSeconds > 0) {
    return `every ${formatInterval(s.intervalSeconds)}`;
  }
  if (s.kind === 'calendar') {
    const time = s.localTimeSeconds != null ? formatLocalTime(s.localTimeSeconds) : '??:??';
    if (s.localDate) return `${s.localDate} ${time}`;
    if (s.daysOfWeek) {
      const days = s.daysOfWeek
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      if (days.length === 7) return `daily ${time}`;
      return `${days.join(',')} ${time}`;
    }
    return `calendar ${time}`;
  }
  return s.kind;
}

export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = seconds / 3600;
    return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  const d = seconds / 86400;
  return Number.isInteger(d) ? `${d}d` : `${d.toFixed(1)}d`;
}

/**
 * Compute the next scheduled fire (unix seconds) after `nowSec`.
 * Returns null if not computable or if the schedule has no future fires.
 *
 * Notes:
 * - Heartbeat anchor defaults to `createdAt` (the manager seed uses this).
 * - Calendar probes the next ~35 days and returns the first matching instant.
 */
export function nextFireSec(s: Schedule, nowSec: number): number | null {
  if (!s.active) return null;
  if (s.kind === 'heartbeat') {
    const interval = s.intervalSeconds;
    if (!interval || interval <= 0) return null;
    const anchor = s.createdAt;
    const elapsed = nowSec - anchor;
    if (elapsed < 0) return anchor;
    const n = Math.floor(elapsed / interval) + 1;
    return anchor + n * interval;
  }
  if (s.kind === 'calendar') {
    const tz = s.timezone ?? 'UTC';
    const timeSec = s.localTimeSeconds;
    if (timeSec == null) return null;
    const daysSet = s.daysOfWeek
      ? new Set(s.daysOfWeek.split(',').map((d) => d.trim().toLowerCase()))
      : null;

    for (let offset = 0; offset < 35; offset++) {
      const probeUnix = nowSec + offset * DAY_SECONDS;
      const info = localDateInfo(new Date(probeUnix * 1000), tz);
      let matches = false;
      if (s.localDate) matches = info.dateStr === s.localDate;
      else if (daysSet) matches = daysSet.has(info.dayOfWeek);
      if (!matches) continue;
      const fire = localToUnix(info.year, info.month, info.day, timeSec, tz);
      if (fire != null && fire > nowSec) return fire;
    }
    return null;
  }
  return null;
}

export function formatLocalTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}

// Strictly fixed-width: exactly 11 visible columns, always. Layout is
// `<countdown padded to 5><space><HH:MM>`. Previously this function
// silently dropped the last digit via a bad padEnd/slice combo.
export function formatNextFire(fireSec: number, nowSec: number): string {
  const d = new Date(fireSec * 1000);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const delta = fireSec - nowSec;
  let countdown: string;
  if (delta < 0) countdown = 'now';
  else if (delta < 60) countdown = '<1m';
  else if (delta < 3600) countdown = `${Math.floor(delta / 60)}m`;
  else if (delta < 86400) countdown = `${Math.floor(delta / 3600)}h`;
  else countdown = `${Math.floor(delta / 86400)}d`;
  // 5-char left-padded countdown + space + HH:MM = 11 chars total.
  return `${countdown.padStart(5)} ${time}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

interface LocalInfo {
  year: number;
  month: number;
  day: number;
  dateStr: string;
  dayOfWeek: string;
}

function localDateInfo(date: Date, tz: string): LocalInfo {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    year,
    month,
    day,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: get('weekday').toLowerCase().slice(0, 3),
  };
}

function localToUnix(
  year: number,
  month: number,
  day: number,
  timeSeconds: number,
  tz: string,
): number | null {
  const h = Math.floor(timeSeconds / 3600);
  const m = Math.floor((timeSeconds % 3600) / 60);
  const s = timeSeconds % 60;
  const utcGuessMs = Date.UTC(year, month - 1, day, h, m, s);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = parseEnCa(fmt.format(new Date(utcGuessMs)));
  if (!parts) return null;
  const localMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offset = localMs - utcGuessMs;
  return (utcGuessMs - offset) / 1000;
}

function parseEnCa(
  str: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const m = str.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}
