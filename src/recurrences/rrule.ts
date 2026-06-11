// Bounded RRULE expansion for the RecurrenceTemplate substrate.
//
// Supports the RFC 5545 subset our migration jobs need (FREQ +
// INTERVAL + BYDAY + UNTIL + COUNT). Expansion is bounded by a
// caller-supplied window AND by a hard `MAX_EXPANSION_INSTANCES`
// cap that prevents a misconfigured RRULE from blowing memory.
//
// CTO scope: cto/output/2026-06-10-recurrence-template-architecture-scope.md
//
// Timezone semantics: ISO date inputs are treated as wall-clock
// dates in the template's timezone (local midnight). Output is
// ISO UTC.

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface ParsedRrule {
  freq: Freq;
  interval: number;
  byday: Weekday[] | null;
  until: string | null; // YYYYMMDD or YYYYMMDDTHHMMSSZ as supplied
  count: number | null;
}

const WEEKDAY_VALUES: readonly Weekday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];
const SUPPORTED_FREQ: readonly Freq[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

/** Hard cap on emitted instances per single expansion call. */
export const MAX_EXPANSION_INSTANCES = 1000;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseRrule(input: string): ParsedRrule {
  const raw = input.trim();
  const body = raw.toUpperCase().startsWith("RRULE:")
    ? raw.slice("RRULE:".length)
    : raw;
  if (!body.includes("=")) {
    throw new Error(`RRULE missing key=value pairs: ${input}`);
  }

  const parts: Record<string, string> = {};
  for (const piece of body.split(";")) {
    const [k, v] = piece.split("=");
    if (!k || v == null) {
      throw new Error(`malformed RRULE segment: ${piece}`);
    }
    parts[k.trim().toUpperCase()] = v.trim();
  }

  const freq = parts["FREQ"];
  if (!freq) throw new Error(`RRULE missing FREQ: ${input}`);
  if (!(SUPPORTED_FREQ as readonly string[]).includes(freq)) {
    throw new Error(`unsupported FREQ in RRULE: ${freq}`);
  }

  const interval = parts["INTERVAL"] ? parseInt(parts["INTERVAL"], 10) : 1;
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error(`invalid INTERVAL in RRULE: ${parts["INTERVAL"]}`);
  }

  let byday: Weekday[] | null = null;
  if (parts["BYDAY"]) {
    const days = parts["BYDAY"].split(",").map((d) => d.trim().toUpperCase());
    for (const d of days) {
      if (!(WEEKDAY_VALUES as readonly string[]).includes(d)) {
        throw new Error(`invalid BYDAY value: ${d}`);
      }
    }
    byday = days as Weekday[];
  }

  const until = parts["UNTIL"] ?? null;
  const count = parts["COUNT"] ? parseInt(parts["COUNT"], 10) : null;
  if (count !== null && (!Number.isFinite(count) || count < 1)) {
    throw new Error(`invalid COUNT in RRULE: ${parts["COUNT"]}`);
  }

  return { freq: freq as Freq, interval, byday, until, count };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default lazy materialization horizon per CTO scope:
 *   daily: 2, weekly: 7, biweekly: 14, monthly: 30, yearly: 45.
 * Reports may override via `materialize_policy.horizon_days`.
 */
export function defaultHorizonForRrule(rrule: string): number {
  const parsed = parseRrule(rrule);
  if (parsed.freq === "DAILY") return 2;
  if (parsed.freq === "WEEKLY") return parsed.interval === 2 ? 14 : 7;
  if (parsed.freq === "MONTHLY") return 30;
  if (parsed.freq === "YEARLY") return 45;
  // Defensive — SUPPORTED_FREQ is closed.
  return 7;
}

// ---------------------------------------------------------------------------
// Expand
// ---------------------------------------------------------------------------

export interface ExpandRruleArgs {
  rrule: string;
  starts_on: string; // YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  timezone: string;
  exception_dates: string[]; // YYYY-MM-DD
  window_start: string; // ISO datetime (any offset)
  window_end: string; // ISO datetime (any offset)
}

/**
 * Returns the ISO-UTC datetimes at which the recurrence fires inside
 * `[window_start, window_end)`, sorted ascending, with exception_dates
 * excluded.
 */
export function expandRrule(args: ExpandRruleArgs): string[] {
  const parsed = parseRrule(args.rrule);
  const starts = parseStartsOn(args.starts_on);
  const startsUtc = wallClockToUtcMillis(starts, args.timezone);
  const exceptionSet = new Set(args.exception_dates);

  const windowStartMs = Date.parse(args.window_start);
  const windowEndMs = Date.parse(args.window_end);
  const untilUtcMillis = parsed.until ? parseUntilToUtcMillis(parsed.until) : null;

  const out: string[] = [];
  let emitted = 0;
  let count = 0; // counts ALL fires the RRULE produces, before window filter

  const cap = MAX_EXPANSION_INSTANCES;

  const tryEmit = (when: { y: number; m: number; d: number; h: number; mi: number; s: number }) => {
    count++;
    if (parsed.count !== null && count > parsed.count) {
      return "STOP" as const;
    }
    const ms = wallClockToUtcMillis(when, args.timezone);
    if (untilUtcMillis !== null && ms > untilUtcMillis) {
      return "STOP" as const;
    }
    if (ms >= windowEndMs) {
      return "STOP" as const;
    }
    if (ms < windowStartMs) {
      return "CONTINUE" as const;
    }
    const dateKey = isoDateKeyForUtcInTz(ms, args.timezone);
    if (exceptionSet.has(dateKey)) {
      return "CONTINUE" as const;
    }
    out.push(isoUtcString(ms));
    emitted++;
    if (emitted >= cap) {
      return "STOP" as const;
    }
    return "CONTINUE" as const;
  };

  if (parsed.freq === "DAILY") {
    let cursor = { ...starts };
    for (let i = 0; i < cap * parsed.interval + 1; i++) {
      const r = tryEmit(cursor);
      if (r === "STOP") break;
      cursor = addDays(cursor, parsed.interval);
    }
  } else if (parsed.freq === "WEEKLY") {
    // For BYDAY: walk week by week (INTERVAL weeks at a time); for
    // each week, emit a fire on each BYDAY whose date >= the week's
    // anchor.
    const bydays = parsed.byday ?? [weekdayOf(starts)];
    let weekAnchor = startOfWeekMonday(starts);
    for (let weekIdx = 0; weekIdx < cap * parsed.interval + 1; weekIdx++) {
      const sortedDays = [...bydays].sort(
        (a, b) => weekdayIndex(a) - weekdayIndex(b),
      );
      for (const wd of sortedDays) {
        const offset = weekdayIndex(wd);
        const fire = addDays(weekAnchor, offset);
        // Don't emit before starts_on.
        if (compareWallClock(fire, starts) < 0) continue;
        const r = tryEmit(fire);
        if (r === "STOP") return out;
      }
      weekAnchor = addDays(weekAnchor, 7 * parsed.interval);
    }
  } else if (parsed.freq === "MONTHLY") {
    let cursor = { ...starts };
    for (let i = 0; i < cap; i++) {
      const r = tryEmit(cursor);
      if (r === "STOP") break;
      cursor = addMonths(cursor, parsed.interval);
    }
  } else if (parsed.freq === "YEARLY") {
    let cursor = { ...starts };
    for (let i = 0; i < cap; i++) {
      const r = tryEmit(cursor);
      if (r === "STOP") break;
      cursor = addYears(cursor, parsed.interval);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers — date math (wall clock)
// ---------------------------------------------------------------------------

interface WallClock {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  h: number;
  mi: number;
  s: number;
}

function parseStartsOn(input: string): WallClock {
  // YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    input,
  );
  if (!m) throw new Error(`unparseable starts_on: ${input}`);
  return {
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: m[4] ? Number(m[4]) : 0,
    mi: m[5] ? Number(m[5]) : 0,
    s: m[6] ? Number(m[6]) : 0,
  };
}

function addDays(c: WallClock, n: number): WallClock {
  // Use Date arithmetic in UTC to avoid DST when adding wall-clock days.
  const dt = new Date(Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s));
  dt.setUTCDate(dt.getUTCDate() + n);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
  };
}

function addMonths(c: WallClock, n: number): WallClock {
  let year = c.y;
  let month = c.m + n;
  while (month > 12) {
    month -= 12;
    year++;
  }
  while (month < 1) {
    month += 12;
    year--;
  }
  // Clamp day to last-day-of-month when overshooting (Jan 31 + 1 mo
  // → Feb 28). Matches the most common operator expectation; users
  // who need BYMONTHDAY-style stricter rules can add an exception.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(c.d, daysInMonth);
  return { ...c, y: year, m: month, d: day };
}

function addYears(c: WallClock, n: number): WallClock {
  return addMonths(c, n * 12);
}

function startOfWeekMonday(c: WallClock): WallClock {
  const idx = weekdayIndex(weekdayOf(c)); // 0=Mon..6=Sun
  return addDays(c, -idx);
}

function weekdayOf(c: WallClock): Weekday {
  // 0..6 with Sun=0 from Date.getUTCDay(); convert to MO..SU.
  const dt = new Date(Date.UTC(c.y, c.m - 1, c.d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dow] as Weekday;
}

function weekdayIndex(w: Weekday): number {
  // 0=Mon..6=Sun
  return ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(w);
}

function compareWallClock(a: WallClock, b: WallClock): number {
  const am = Date.UTC(a.y, a.m - 1, a.d, a.h, a.mi, a.s);
  const bm = Date.UTC(b.y, b.m - 1, b.d, b.h, b.mi, b.s);
  return am - bm;
}

// ---------------------------------------------------------------------------
// Helpers — timezone math
// ---------------------------------------------------------------------------

/**
 * Convert wall-clock components in `timezone` to UTC milliseconds.
 * Uses Intl.DateTimeFormat to look up the timezone offset and corrects
 * for DST. One iteration is enough for non-DST-boundary moments.
 */
function wallClockToUtcMillis(c: WallClock, timezone: string): number {
  if (timezone === "UTC") {
    return Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
  }
  const guess = Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
  const offsetMin = tzOffsetMinutes(guess, timezone);
  const adjusted = guess - offsetMin * 60 * 1000;
  // One more refinement pass to absorb DST when the guess straddles a
  // transition.
  const offsetMin2 = tzOffsetMinutes(adjusted, timezone);
  if (offsetMin2 !== offsetMin) {
    return guess - offsetMin2 * 60 * 1000;
  }
  return adjusted;
}

function tzOffsetMinutes(utcMillis: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(utcMillis));
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const localMs = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour === "24" ? "0" : lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );
  return Math.round((localMs - utcMillis) / 60000);
}

function isoDateKeyForUtcInTz(utcMillis: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(utcMillis));
}

function parseUntilToUtcMillis(until: string): number {
  // RFC 5545 UNTIL is either YYYYMMDD (date) or YYYYMMDDTHHMMSSZ.
  if (/^\d{8}$/.test(until)) {
    const y = Number(until.slice(0, 4));
    const m = Number(until.slice(4, 6));
    const d = Number(until.slice(6, 8));
    // Treat date-only UNTIL as end-of-day UTC, matching common
    // operator intent: "until 2027-12-31" should include 12-31.
    return Date.UTC(y, m - 1, d, 23, 59, 59);
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(until);
  if (!m) throw new Error(`unparseable UNTIL: ${until}`);
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

function isoUtcString(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
