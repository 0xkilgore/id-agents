// Claude Code session rotation / compaction.
//
// Long-lived claude-code-cli agents resume the SAME on-disk session transcript
// (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`) on every dispatch. Those
// transcripts grow unbounded; once the resumed context is large enough, every
// invocation reloads it and burns the provider rate limit
// (`provider_rate_limit_exhausted`). This is the Sentinel session-bloat failure.
//
// This module rotates BEFORE each launch: if the session about to be resumed is
// over a size threshold it is ARCHIVED (moved, never deleted) and the launch
// starts a fresh session. Stale/oversize dead sessions are swept for hygiene.
// Best-effort and fully defensive — it must never throw into the launch path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionRotationConfig {
  enabled: boolean;
  /** Rotate the session being resumed when its transcript is >= this many bytes. */
  max_bytes: number;
  /** Sweep dead (non-resumed) session transcripts older than this many days. */
  max_age_days: number;
  /** Root of Claude Code's per-project session store. */
  projects_root: string;
  /** Where archived transcripts are moved (reversible). */
  archive_root: string;
}

function intEnv(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function boolEnv(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

export function loadSessionRotationConfig(env: NodeJS.ProcessEnv = process.env): SessionRotationConfig {
  const home = env.HOME || os.homedir();
  return {
    enabled: boolEnv(env.CLAUDE_SESSION_ROTATION_ENABLED, true),
    // 3MB: Sentinel's session caused rate-limits at ~4.8MB; rotate before the
    // pain point. Healthy fleet agents sit in the KB range. Env-tunable.
    max_bytes: intEnv(env.CLAUDE_SESSION_MAX_BYTES, 3_000_000),
    max_age_days: intEnv(env.CLAUDE_SESSION_MAX_AGE_DAYS, 14),
    projects_root: env.CLAUDE_SESSION_PROJECTS_ROOT || path.join(home, ".claude", "projects"),
    archive_root: env.CLAUDE_SESSION_ARCHIVE_ROOT || path.join(home, ".claude", "session-archives"),
  };
}

/** Claude Code encodes a working directory to a project dir by mapping `/` and `.` to `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export interface RotateInput {
  workingDirectory: string;
  /** Session id about to be resumed (if any). */
  resume?: string;
  config?: SessionRotationConfig;
  now?: number;
}

export interface RotateResult {
  /** The session id to actually resume — `undefined` when rotation forced a fresh start. */
  resume: string | undefined;
  /** Basenames of transcripts archived this call. */
  rotated: string[];
  reason?: string;
}

function archiveFile(
  config: SessionRotationConfig,
  cwd: string,
  fullPath: string,
  basename: string,
  now: number,
): boolean {
  try {
    const tag = encodeProjectDir(cwd).replace(/^-+/, "") || "session";
    const ts = new Date(now).toISOString().replace(/[:.]/g, "-");
    const destDir = path.join(config.archive_root, `${tag}-${ts}`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(fullPath, path.join(destDir, basename));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate the agent's Claude Code session store if needed. Returns the session id
 * to actually resume (cleared when the resume target was rotated) plus the list
 * of archived transcripts. NEVER throws — on any error it returns the input
 * resume unchanged so the launch proceeds.
 */
export function rotateSessionsIfNeeded(input: RotateInput): RotateResult {
  const resume = input.resume;
  try {
    const config = input.config ?? loadSessionRotationConfig();
    if (!config.enabled || !input.workingDirectory) return { resume, rotated: [] };
    const now = input.now ?? Date.now();
    const dir = path.join(config.projects_root, encodeProjectDir(input.workingDirectory));
    if (!fs.existsSync(dir)) return { resume, rotated: [] };

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const rotated: string[] = [];
    let effectiveResume = resume;
    let reason: string | undefined;
    const ageCutMs = config.max_age_days * 86_400_000;

    for (const file of files) {
      const full = path.join(dir, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const sessionId = file.replace(/\.jsonl$/, "");
      const tooBig = st.size >= config.max_bytes;

      if (resume !== undefined && sessionId === resume) {
        // The active session: only rotate when oversize (never archive a small
        // session we're about to resume just for age).
        if (tooBig) {
          if (archiveFile(config, input.workingDirectory, full, file, now)) {
            rotated.push(file);
            effectiveResume = undefined; // force a fresh session
            reason = `resume target ${sessionId} is ${st.size} bytes >= ${config.max_bytes}; starting fresh`;
          }
        }
        continue;
      }

      // Dead (non-resumed) transcripts: sweep when oversize or stale — hygiene.
      const tooOld = now - st.mtimeMs >= ageCutMs;
      if (tooBig || tooOld) {
        if (archiveFile(config, input.workingDirectory, full, file, now)) rotated.push(file);
      }
    }

    return { resume: effectiveResume, rotated, reason };
  } catch {
    return { resume, rotated: [] };
  }
}
