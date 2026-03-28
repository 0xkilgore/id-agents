// SPDX-License-Identifier: MIT

/**
 * Pure logic module for computing due schedule runs within a time window.
 *
 * Stateless and side-effect free — all inputs are explicit parameters,
 * making this module easy to unit test without database or clock mocks.
 */

import type { DueRun } from './schedule-types.js';
import type { ScheduleDefinitionRow } from '../db/types.js';

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Convert a local date + time-of-day + IANA timezone to a UTC unix timestamp
 * (seconds). Returns null if the local time does not exist (DST spring-forward
 * gap).
 *
 * Algorithm:
 *   1. Treat the local components as if they were UTC ("UTC guess").
 *   2. Format the UTC guess in the target timezone to see what local time
 *      it actually represents there.
 *   3. Compute the offset from the difference.
 *   4. Adjust the guess by the offset to get the true UTC instant.
 *   5. Verify the result maps back to the requested local time (catches
 *      DST spring-forward cases where the local time doesn't exist).
 *
 * Exported for testing.
 */
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

  // Step 1: Construct a UTC guess (pretend local components are UTC)
  const utcGuessMs = Date.UTC(year, month - 1, day, h, m, s);

  // Formatter that renders a UTC instant as a local date/time string in the
  // target timezone.  en-CA gives us "YYYY-MM-DD, HH:MM:SS" which is easy to
  // parse deterministically.
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

  // Step 2: See what local time the UTC guess maps to in the target timezone
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

  // Step 3: The timezone offset (local ahead of UTC = positive)
  const offsetMs = localOfGuessMs - utcGuessMs;

  // Step 4: Actual UTC = guess shifted by the offset
  const actualUtcMs = utcGuessMs - offsetMs;

  // Step 5: Verify — format the actual UTC in the target timezone and confirm
  // it matches the requested local time.  A mismatch means the requested local
  // time falls in a DST spring-forward gap and does not exist.
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
    // Local time does not exist (DST spring-forward gap)
    return null;
  }

  return actualUtcMs / 1000;
}

/**
 * Parse an en-CA formatted datetime string "YYYY-MM-DD, HH:MM:SS" into
 * numeric components.  Returns null on unexpected format.
 */
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
  // en-CA with hour12:false produces "YYYY-MM-DD, HH:MM:SS"
  // Some environments may use a period or other separator — be tolerant.
  const match = str.match(
    /(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/,
  );
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

/**
 * Get the abbreviated lowercase day-of-week (mon, tue, wed, thu, fri, sat, sun)
 * for a calendar date in the given IANA timezone.
 *
 * We use noon UTC as an initial approximation (close enough for a date-only
 * query) and then verify via the timezone-aware formatter.
 *
 * Exported for testing.
 */
export function getDayOfWeek(
  year: number,
  month: number,
  day: number,
  tz: string,
): string {
  // Pick noon UTC on the given date as a rough anchor — the weekday formatter
  // in the target timezone will almost always be correct for noon UTC, even for
  // extreme timezone offsets (UTC+14 shifts noon UTC to 02:00 the next day, but
  // we account for that by using the formatted result rather than JS getDay).
  const approx = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  })
    .format(approx)
    .toLowerCase()
    .slice(0, 3);
  return dayName;
}

// ---------------------------------------------------------------------------
// Interval schedule evaluation
// ---------------------------------------------------------------------------

/**
 * Compute all logical interval runs that fall within (windowStart, windowEnd].
 *
 * Each interval schedule has an `anchor_at` (unix seconds) and an
 * `interval_seconds`.  Logical run number `n` has scheduled instant
 * `anchor_at + n * interval_seconds`.
 *
 * Catch-up policies:
 *   - `fire_once`: after downtime, return only the LATEST due run (at most 1).
 *   - `skip`: only return runs whose scheduled_at is within
 *     `dedupe_window_seconds` of windowEnd (i.e. recent enough to fire).
 */
export function evaluateIntervalSchedule(
  def: ScheduleDefinitionRow,
  windowStart: number,
  windowEnd: number,
): DueRun[] {
  if (def.interval_seconds == null || def.anchor_at == null) return [];

  const interval = def.interval_seconds;
  const anchor = def.anchor_at;

  // First run number whose scheduled_at is > windowStart
  const nStart = Math.floor((windowStart - anchor) / interval) + 1;
  // Last run number whose scheduled_at is <= windowEnd
  const nEnd = Math.floor((windowEnd - anchor) / interval);

  if (nEnd < nStart || nEnd < 0) return [];

  const runs: DueRun[] = [];

  // Iterate from latest to earliest so that fire_once can break early
  for (let n = nEnd; n >= nStart && n >= 0; n--) {
    const scheduledAt = anchor + n * interval;

    // The scheduled instant must be strictly inside (windowStart, windowEnd]
    if (scheduledAt <= windowStart) continue;

    // Respect absolute expiry
    if (def.expires_at != null && scheduledAt >= def.expires_at) continue;

    // Respect max_runs: run numbers are 0-indexed, so run n is the (n+1)th run
    if (def.max_runs != null && n >= def.max_runs) continue;

    runs.push({
      scheduleId: def.id,
      scheduledKey: `interval:${scheduledAt}`,
      scheduledAt,
      kind: 'interval',
    });

    // fire_once: only the latest eligible run
    if (def.catch_up_policy === 'fire_once') break;
  }

  // skip policy: drop runs that are too old (further from windowEnd than the
  // dedupe window allows)
  if (def.catch_up_policy === 'skip') {
    const cutoff = windowEnd - def.dedupe_window_seconds;
    return runs.filter((r) => r.scheduledAt >= cutoff);
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Calendar schedule evaluation
// ---------------------------------------------------------------------------

/**
 * Compute all logical calendar runs that fall within (windowStart, windowEnd].
 *
 * Calendar schedules match by local wall-clock time in the schedule's timezone:
 *   - One-off schedules match a single `local_date`.
 *   - Recurring schedules match `days_of_week` (comma-separated, e.g. "mon,wed,fri").
 *
 * Catch-up policies work the same as for interval schedules:
 *   - `fire_once`: return only the latest due run.
 *   - `skip`: only return runs within `dedupe_window_seconds` of windowEnd.
 */
export function evaluateCalendarSchedule(
  def: ScheduleDefinitionRow,
  windowStart: number,
  windowEnd: number,
): DueRun[] {
  if (def.local_time_seconds == null || !def.timezone) return [];

  const tz = def.timezone;
  const timeSeconds = def.local_time_seconds;

  // Parse days_of_week into a Set for recurring schedules
  const daysSet = def.days_of_week
    ? new Set(def.days_of_week.split(',').map((s) => s.trim().toLowerCase()))
    : null;

  // Enumerate candidate UTC days that could contain a matching local date.
  // We pad by ±1 day to handle timezone offsets (e.g. UTC+14 or UTC-12) that
  // might shift the local date relative to the UTC date.
  const startDay = new Date((windowStart - 86400) * 1000);
  const endDay = new Date((windowEnd + 86400) * 1000);

  const runs: DueRun[] = [];
  const current = new Date(startDay);

  while (current <= endDay) {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const day = current.getUTCDate();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Check whether this calendar day is a match
    let matches = false;
    if (def.local_date) {
      // One-off: exact date match
      matches = dateStr === def.local_date;
    } else if (daysSet) {
      // Recurring: check day-of-week in the schedule's timezone
      const dow = getDayOfWeek(year, month, day, tz);
      matches = daysSet.has(dow);
    }

    if (matches) {
      // Convert the local date + time + timezone to a UTC unix timestamp
      const unixSec = localToUnix(year, month, day, timeSeconds, tz);

      if (
        unixSec != null &&
        unixSec > windowStart &&
        unixSec <= windowEnd
      ) {
        // Respect absolute expiry
        if (def.expires_at == null || unixSec < def.expires_at) {
          const scheduledKey = `calendar:${dateStr}@${timeSeconds}`;
          runs.push({
            scheduleId: def.id,
            scheduledKey,
            scheduledAt: unixSec,
            kind: 'calendar',
          });
        }
      }
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  if (runs.length === 0) return [];

  // Apply catch-up policy
  if (def.catch_up_policy === 'fire_once') {
    // Return only the latest run
    return [runs[runs.length - 1]!];
  }

  if (def.catch_up_policy === 'skip') {
    const cutoff = windowEnd - def.dedupe_window_seconds;
    return runs.filter((r) => r.scheduledAt >= cutoff);
  }

  return runs;
}
