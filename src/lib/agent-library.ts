// SPDX-License-Identifier: MIT
/**
 * Agent-config v3 — library enumerators.
 *
 * Discovers installable library entries under a fixed root
 * (in-repo this is expected to be `<repoRoot>/configs`):
 *   - Agents at  <libRoot>/agents/
 *   - Skills at  <libRoot>/skills/<name>/SKILL.md
 *
 * Two native agent source shapes are supported (per the v3 plan):
 *   - 'claude-native'     directory entry with CLAUDE.md at <name>/CLAUDE.md
 *   - 'agents-md-native'  sibling pair: file at <name>.md + directory at <name>/
 *
 * Scope: discovery / listing / modeling only. No parsing, copying,
 * receipts, deploy, undeploy, mapping, or config integration.
 */

import fs from 'fs';
import path from 'path';

/** Which native source shape an agent library entry uses. */
export type AgentLibraryShape = 'claude-native' | 'agents-md-native';

/** Entry name pattern — same rule as agent names elsewhere in the codebase. */
const ENTRY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface LibraryAgentEntry {
  /** Logical agent name (directory name, or filename stem for the sibling-file form). */
  name: string;
  /** Native shape this entry uses. */
  shape: AgentLibraryShape;
  /** Absolute path to the entry's directory. Present for both shapes. */
  dirPath: string;
  /** Absolute path to the persona/memory markdown file for this entry. */
  memoryFile: string;
}

export type LibraryAgentErrorCode =
  | 'mixed-shape'
  | 'incomplete-agents-md-native';

/** A discovery problem surfaced to the caller without aborting the scan. */
export interface LibraryAgentError {
  name: string;
  code: LibraryAgentErrorCode;
  message: string;
}

export interface LibraryAgentScan {
  entries: LibraryAgentEntry[];
  errors: LibraryAgentError[];
}

export interface LibrarySkillEntry {
  name: string;
  dirPath: string;
  skillFile: string;
}

export interface LibraryPaths {
  agents: string;
  skills: string;
}

/**
 * Build the fixed library subpaths under a given library root
 * (for example, `<repoRoot>/configs`).
 *
 *   <libRoot>/agents
 *   <libRoot>/skills
 */
export function getLibraryPaths(libRoot: string): LibraryPaths {
  return {
    agents: path.join(libRoot, 'agents'),
    skills: path.join(libRoot, 'skills'),
  };
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isValidEntryName(name: string): boolean {
  return ENTRY_NAME_RE.test(name);
}

/**
 * Enumerate agent library entries under `agentsDir` (typically `<libRoot>/agents`).
 *
 * Discovery rules:
 *   - `<name>/CLAUDE.md` exists                                   → 'claude-native' entry
 *   - `<name>.md` AND sibling `<name>/` both exist (no CLAUDE.md) → 'agents-md-native' entry
 *   - `<name>/CLAUDE.md` AND sibling `<name>.md` both exist       → mixed-shape error (dedup refusal)
 *   - `<name>.md` exists but sibling `<name>/` is missing         → incomplete-agents-md-native error
 *   - Anything else (stray directories, unrecognised files, names failing `ENTRY_NAME_RE`)
 *     is silently skipped.
 *
 * Returns an empty scan if `agentsDir` does not exist. Never throws for individual entries.
 */
export function enumerateLibraryAgents(agentsDir: string): LibraryAgentScan {
  if (!isDirectory(agentsDir)) return { entries: [], errors: [] };

  type Candidate = {
    hasDir: boolean;
    hasSiblingMd: boolean;
    hasClaudeMd: boolean;
  };

  const byName = new Map<string, Candidate>();
  const touch = (name: string): Candidate => {
    let c = byName.get(name);
    if (!c) {
      c = { hasDir: false, hasSiblingMd: false, hasClaudeMd: false };
      byName.set(name, c);
    }
    return c;
  };

  const children = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const child of children) {
    if (child.isDirectory()) {
      const name = child.name;
      if (!isValidEntryName(name)) continue;
      const c = touch(name);
      c.hasDir = true;
      c.hasClaudeMd = isFile(path.join(agentsDir, name, 'CLAUDE.md'));
    } else if (child.isFile()) {
      const fname = child.name;
      if (!fname.endsWith('.md')) continue;
      const name = fname.slice(0, -'.md'.length);
      if (!isValidEntryName(name)) continue;
      touch(name).hasSiblingMd = true;
    }
  }

  const entries: LibraryAgentEntry[] = [];
  const errors: LibraryAgentError[] = [];

  for (const [name, c] of byName) {
    const dirPath = path.join(agentsDir, name);

    if (c.hasClaudeMd && c.hasSiblingMd) {
      errors.push({
        name,
        code: 'mixed-shape',
        message:
          `Entry '${name}' has both '${name}/CLAUDE.md' (claude-native) ` +
          `and sibling '${name}.md' (agents-md-native). Choose one shape.`,
      });
      continue;
    }

    if (c.hasClaudeMd) {
      entries.push({
        name,
        shape: 'claude-native',
        dirPath,
        memoryFile: path.join(dirPath, 'CLAUDE.md'),
      });
      continue;
    }

    if (c.hasSiblingMd && c.hasDir) {
      entries.push({
        name,
        shape: 'agents-md-native',
        dirPath,
        memoryFile: path.join(agentsDir, `${name}.md`),
      });
      continue;
    }

    if (c.hasSiblingMd && !c.hasDir) {
      errors.push({
        name,
        code: 'incomplete-agents-md-native',
        message:
          `Sibling file '${name}.md' exists but required sibling directory '${name}/' is missing.`,
      });
      continue;
    }

    // Directory with neither CLAUDE.md nor sibling .md: silently skip.
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  errors.sort((a, b) => {
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.code.localeCompare(b.code);
  });

  return { entries, errors };
}

/**
 * Enumerate skill library entries under `skillsDir` (typically `<libRoot>/skills`).
 *
 * A directory is included iff it contains `SKILL.md`. Names failing `ENTRY_NAME_RE`
 * and non-directory children are silently skipped.
 *
 * Returns an empty array if `skillsDir` does not exist.
 */
export function enumerateLibrarySkills(skillsDir: string): LibrarySkillEntry[] {
  if (!isDirectory(skillsDir)) return [];

  const entries: LibrarySkillEntry[] = [];
  const children = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const name = child.name;
    if (!isValidEntryName(name)) continue;

    const dirPath = path.join(skillsDir, name);
    const skillFile = path.join(dirPath, 'SKILL.md');
    if (!isFile(skillFile)) continue;

    entries.push({ name, dirPath, skillFile });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
