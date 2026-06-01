// Usage Meter — daily / weekly rollup math in any IANA timezone.
//
// Pure functions. Day = local midnight to next local midnight.
// Week = local Monday 00:00 to next Monday 00:00.
// Uses Intl.DateTimeFormat for timezone arithmetic so we don't pull in
// a date library.

import type {
  AgentUsageRollup,
  AttributionConfidence,
  Provider,
  WindowKind,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Internal tz helpers
// ─────────────────────────────────────────────────────────────────────

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
}

function getLocalParts(unixMs: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
  });
  const parts = fmt.formatToParts(new Date(unixMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
    weekday: get("weekday"),
  };
}

function getOffsetMinutes(unixMs: number, tz: string): number {
  // Use longOffset so we always get "GMT-05:00" / "GMT+09:30" form.
  const fmt = new Intl.DateTimeFormat("en", {
    timeZone: tz,
    timeZoneName: "longOffset",
  });
  const parts = fmt.formatToParts(new Date(unixMs));
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = parseInt(m[2]!, 10);
  const minutes = parseInt(m[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
}

function startOfDayInTz(unixMs: number, tz: string): number {
  const p = getLocalParts(unixMs, tz);
  const offsetMs =
    (parseInt(p.hour, 10) * 3600 +
      parseInt(p.minute, 10) * 60 +
      parseInt(p.second, 10)) *
    1000;
  return unixMs - offsetMs;
}

function startOfWeekInTz(unixMs: number, tz: string): number {
  const dayStart = startOfDayInTz(unixMs, tz);
  const weekday = getLocalParts(dayStart, tz).weekday;
  // Spec uses Monday-start weeks.
  const fromMonday: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  return dayStart - (fromMonday[weekday] ?? 0) * 86_400_000;
}

function isoWithOffsetInTz(unixMs: number, tz: string): string {
  const p = getLocalParts(unixMs, tz);
  const offsetMin = getOffsetMinutes(unixMs, tz);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000${sign}${oh}:${om}`;
}

// ─────────────────────────────────────────────────────────────────────
// Day / Week window
// ─────────────────────────────────────────────────────────────────────

export interface UsageWindow {
  start: string;
  end: string;
  /** Unix ms of the inclusive start (handy for fast in-window filtering). */
  start_ms: number;
  /** Unix ms of the exclusive end. */
  end_ms: number;
}

export function computeDayWindow(unixMs: number, tz: string): UsageWindow {
  const start = startOfDayInTz(unixMs, tz);
  const end = startOfDayInTz(start + 36 * 3600_000, tz); // skip forward into the next day, then snap
  return {
    start: isoWithOffsetInTz(start, tz),
    end: isoWithOffsetInTz(end, tz),
    start_ms: start,
    end_ms: end,
  };
}

export function computeWeekWindow(unixMs: number, tz: string): UsageWindow {
  const start = startOfWeekInTz(unixMs, tz);
  const end = startOfWeekInTz(start + 8 * 86_400_000, tz);
  return {
    start: isoWithOffsetInTz(start, tz),
    end: isoWithOffsetInTz(end, tz),
    start_ms: start,
    end_ms: end,
  };
}

// ─────────────────────────────────────────────────────────────────────
// rollupEvents — per-agent + synthetic "_global" per window
// ─────────────────────────────────────────────────────────────────────

export interface RollupEventInput {
  agent_id: string;
  ts: number;
  raw_tokens: number;
  weighted_tokens: number;
  model: string | null;
  source: "claude_code_transcripts" | "manual_ingest" | "other";
  confidence?: AttributionConfidence;
}

export interface RollupOptions {
  provider: Provider;
  timezone: string;
  /** ISO timestamp identifying the "current" window. */
  now_iso: string;
  /** Which windows to compute. */
  window_kinds: WindowKind[];
}

export function rollupEvents(
  events: RollupEventInput[],
  opts: RollupOptions,
): AgentUsageRollup[] {
  const nowMs = Date.parse(opts.now_iso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`rollupEvents: invalid now_iso ${opts.now_iso}`);
  }
  const windows: Record<WindowKind, UsageWindow> = {
    day: computeDayWindow(nowMs, opts.timezone),
    week: computeWeekWindow(nowMs, opts.timezone),
  };

  // Map: agent_id + windowKind → accumulator
  type Accum = {
    raw: number;
    weighted: number;
    requests: number;
    models: Set<string>;
    sourceCoverage: Record<string, number>;
  };
  const acc = new Map<string, Accum>();
  const ensure = (key: string): Accum => {
    let a = acc.get(key);
    if (!a) {
      a = { raw: 0, weighted: 0, requests: 0, models: new Set(), sourceCoverage: {} };
      acc.set(key, a);
    }
    return a;
  };

  for (const kind of opts.window_kinds) {
    const w = windows[kind];
    for (const ev of events) {
      if (ev.ts < w.start_ms || ev.ts >= w.end_ms) continue;
      const pKey = `${kind}:${ev.agent_id}`;
      const gKey = `${kind}:_global`;
      const perAgent = ensure(pKey);
      const global = ensure(gKey);
      for (const a of [perAgent, global]) {
        a.raw += ev.raw_tokens;
        a.weighted += ev.weighted_tokens;
        a.requests += 1;
        if (ev.model) a.models.add(ev.model);
        a.sourceCoverage[ev.source] = (a.sourceCoverage[ev.source] ?? 0) + 1;
      }
    }
  }

  const out: AgentUsageRollup[] = [];
  const computedAt = opts.now_iso;
  for (const [key, a] of acc) {
    const [kindStr, ...agentParts] = key.split(":");
    const kind = kindStr as WindowKind;
    const agent_id = agentParts.join(":");
    const w = windows[kind];
    out.push({
      provider: opts.provider,
      agent_id,
      window_kind: kind,
      window_start: w.start,
      window_end: w.end,
      raw_tokens: a.raw,
      weighted_tokens: a.weighted,
      requests: a.requests,
      models: [...a.models],
      source_coverage: a.sourceCoverage,
      computed_at: computedAt,
    });
  }
  return out;
}
