// SPDX-License-Identifier: MIT

/**
 * Pure logic module for computing due schedule runs within a time window.
 */

import type { DueRun } from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

export function localToUnix(
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

  const localStr = fmt.format(new Date(utcGuessMs));
  const localParts = parseEnCaDateTime(localStr);
  if (!localParts) return null;

  const localOfGuessMs = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second,
  );

  const offsetMs = localOfGuessMs - utcGuessMs;
  const actualUtcMs = utcGuessMs - offsetMs;

  const verifyStr = fmt.format(new Date(actualUtcMs));
  const verifyParts = parseEnCaDateTime(verifyStr);
  if (!verifyParts) return null;

  if (
    verifyParts.year !== year ||
    verifyParts.month !== month ||
    verifyParts.day !== day ||
    verifyParts.hour !== h ||
    verifyParts.minute !== m
  ) {
    return null;
  }

  return actualUtcMs / 1000;
}

function parseEnCaDateTime(
  str: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const match = str.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };
}

function localDateInfo(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  dateStr: string;
  dayOfWeek: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const dayOfWeek = get('weekday').toLowerCase().slice(0, 3);

  return { year, month, day, dateStr, dayOfWeek };
}

export function getDayOfWeek(
  year: number,
  month: number,
  day: number,
  tz: string,
): string {
  return localDateInfo(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)), tz).dayOfWeek;
}

export function evaluateIntervalSchedule(
  def: ScheduleDefinitionRow,
  windowStart: number,
  windowEnd: number,
): DueRun[] {
  if (def.interval_seconds == null || def.anchor_at == null) return [];

  const interval = def.interval_seconds;
  const anchor = def.anchor_at;
  const nStart = Math.floor((windowStart - anchor) / interval) + 1;
  const nEnd = Math.floor((windowEnd - anchor) / interval);

  if (nEnd < nStart || nEnd < 0) return [];

  const runs: DueRun[] = [];
  for (let n = nEnd; n >= nStart && n >= 0; n--) {
    const scheduledAt = anchor + n * interval;
    if (scheduledAt <= windowStart) continue;
    if (def.expires_at != null && scheduledAt >= def.expires_at) continue;
    if (def.max_runs != null && n >= def.max_runs) continue;

    runs.push({
      scheduleId: def.id,
      scheduledKey: `heartbeat:${scheduledAt}`,
      scheduledAt,
      kind: 'heartbeat',
    });

    if (def.catch_up_policy === 'fire_once') break;
  }

  if (def.catch_up_policy === 'skip') {
    const cutoff = windowEnd - def.dedupe_window_seconds;
    return runs.filter((r) => r.scheduledAt >= cutoff);
  }

  return runs;
}

export function evaluateCalendarSchedule(
  def: ScheduleDefinitionRow,
  windowStart: number,
  windowEnd: number,
): DueRun[] {
  if (def.local_time_seconds == null || !def.timezone) return [];

  const tz = def.timezone;
  const timeSeconds = def.local_time_seconds;
  const daysSet = def.days_of_week
    ? new Set(def.days_of_week.split(',').map((s) => s.trim().toLowerCase()))
    : null;

  const startDay = new Date((windowStart - 86400) * 1000);
  const endDay = new Date((windowEnd + 86400) * 1000);

  const runs: DueRun[] = [];
  const seenLocalDates = new Set<string>();
  const current = new Date(startDay);

  while (current <= endDay) {
    const info = localDateInfo(current, tz);
    if (!seenLocalDates.has(info.dateStr)) {
      seenLocalDates.add(info.dateStr);

      let matches = false;
      if (def.local_date) {
        matches = info.dateStr === def.local_date;
      } else if (daysSet) {
        matches = daysSet.has(info.dayOfWeek);
      }

      if (matches) {
        const unixSec = localToUnix(info.year, info.month, info.day, timeSeconds, tz);
        if (unixSec != null && unixSec > windowStart && unixSec <= windowEnd) {
          if (def.expires_at == null || unixSec < def.expires_at) {
            runs.push({
              scheduleId: def.id,
              scheduledKey: `calendar:${info.dateStr}@${timeSeconds}`,
              scheduledAt: unixSec,
              kind: 'calendar',
            });
          }
        }
      }
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  if (runs.length === 0) return [];
  runs.sort((a, b) => a.scheduledAt - b.scheduledAt);

  if (def.catch_up_policy === 'fire_once') {
    return [runs[runs.length - 1]!];
  }

  if (def.catch_up_policy === 'skip') {
    const cutoff = windowEnd - def.dedupe_window_seconds;
    return runs.filter((r) => r.scheduledAt >= cutoff);
  }

  return runs;
}
