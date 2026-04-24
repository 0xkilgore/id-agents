// SPDX-License-Identifier: MIT
/**
 * Agent-config v3 slice 7 — read-only library inventory helpers.
 *
 * Thin wrappers around the slice-1 enumerators in `./agent-library.ts`
 * that produce JSON-friendly response shapes for manager HTTP routes.
 * No shape detection is duplicated here; filesystem classification
 * stays in the enumerator. Everything beyond "is this a library entry"
 * — README / LICENSE presence, subfolder listings, SKILL.md frontmatter
 * — is metadata enrichment and lives here.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  enumerateLibraryAgents,
  enumerateLibrarySkills,
  getLibraryPaths,
  type AgentLibraryShape,
  type LibraryAgentError,
} from './agent-library.js';

export interface AgentListEntry {
  name: string;
  shape: AgentLibraryShape;
  hasReadme: boolean;
  hasLicense: boolean;
  /** Immediate subdirectory names (non-dot) under the entry's directory. */
  subfolders: string[];
  /** Absolute filesystem path to the entry's directory. */
  source_path: string;
}

export interface AgentDetail extends AgentListEntry {
  /** Absolute path to the persona / memory markdown file. */
  memoryFile: string;
  /** README body, or null when no README.md is present. */
  readme: string | null;
  /** Raw CLAUDE.md body (claude-native) or sibling `<name>.md` body (agents-md-native). */
  memory: string;
  /** Names of bundled skills discovered under the entry's `skills/` subdir. */
  bundledSkills: string[];
}

export interface SkillListEntry {
  name: string;
  /**
   * Whether a SKILL.md file is present under the skill directory. Always
   * true for enumerated entries (the enumerator requires it) but included
   * in the contract so the TUI can render the check uniformly and so a
   * future caller that loosens the enumerator sees the flag.
   */
  hasSkillMd: boolean;
  /** Absolute filesystem path to the skill directory. */
  source_path: string;
}

export interface SkillDetail extends SkillListEntry {
  /** Absolute path to the SKILL.md file. */
  skillFile: string;
  /** Frontmatter name field, or null if missing / unparsable. */
  skillName: string | null;
  /** Frontmatter description field, or null if missing / unparsable. */
  description: string | null;
  /** Character length of the SKILL.md body (post-frontmatter). */
  bodyLength: number;
}

export interface AgentListResult {
  /** Absolute library root, or null when the manager has no library configured. */
  libraryRoot: string | null;
  entries: AgentListEntry[];
  /** Discovery errors surfaced by the enumerator (mixed-shape, incomplete pair). */
  errors: LibraryAgentError[];
}

export interface SkillListResult {
  libraryRoot: string | null;
  entries: SkillListEntry[];
}

/**
 * Default library-root resolution used by the manager HTTP endpoints.
 *
 * Consistent with slice-2's in-process default: the in-repo library lives
 * at `<repoRoot>/configs`. Operators can override with `ID_LIBRARY_ROOT`
 * to point at an out-of-tree library (e.g. the `public-agents/configs`
 * used by the slice-3 workspace-sync demos).
 *
 * Resolution order:
 *   1. process.env.ID_LIBRARY_ROOT when set and existing on disk
 *   2. <cwd>/configs when present
 *   3. null (no library configured)
 *
 * Returning null rather than throwing lets the routes answer with an
 * empty list instead of a 500, matching the brief's "no library
 * configured -> empty list rather than error" contract.
 */
export function resolveDefaultLibraryRoot(): string | null {
  const envRoot = process.env.ID_LIBRARY_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (fs.existsSync(resolved)) return resolved;
  }
  const cwdRoot = path.resolve(process.cwd(), 'configs');
  if (fs.existsSync(cwdRoot)) return cwdRoot;
  return null;
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listSubfolders(dirPath: string): string[] {
  if (!dirExists(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function readFileIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function bundledSkillNames(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, 'skills');
  return enumerateLibrarySkills(skillsDir).map(e => e.name);
}

function decorateAgentEntry(
  name: string,
  shape: AgentLibraryShape,
  dirPath: string,
): AgentListEntry {
  return {
    name,
    shape,
    hasReadme: fileExists(path.join(dirPath, 'README.md')),
    hasLicense: fileExists(path.join(dirPath, 'LICENSE')),
    subfolders: listSubfolders(dirPath),
    source_path: dirPath,
  };
}

function decorateSkillEntry(name: string, dirPath: string): SkillListEntry {
  return {
    name,
    hasSkillMd: fileExists(path.join(dirPath, 'SKILL.md')),
    source_path: dirPath,
  };
}

function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (yaml.load(match[1]) as Record<string, unknown>) || {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: match[2] };
}

function stringFieldOrNull(frontmatter: Record<string, unknown>, key: string): string | null {
  const v = frontmatter[key];
  return typeof v === 'string' ? v : null;
}

export function listLibraryAgents(libraryRoot: string | null): AgentListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [], errors: [] };
  }
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  return {
    libraryRoot,
    entries: scan.entries.map(entry =>
      decorateAgentEntry(entry.name, entry.shape, entry.dirPath),
    ),
    errors: scan.errors,
  };
}

export function getLibraryAgent(
  libraryRoot: string | null,
  name: string,
): AgentDetail | null {
  if (!libraryRoot) return null;
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  const entry = scan.entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateAgentEntry(entry.name, entry.shape, entry.dirPath);
  const readmePath = path.join(entry.dirPath, 'README.md');
  const memoryBody = readFileIfExists(entry.memoryFile) ?? '';

  return {
    ...base,
    memoryFile: entry.memoryFile,
    readme: readFileIfExists(readmePath),
    memory: memoryBody,
    bundledSkills: bundledSkillNames(entry.dirPath),
  };
}

export function listLibrarySkills(libraryRoot: string | null): SkillListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [] };
  }
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  return {
    libraryRoot,
    entries: entries.map(entry => decorateSkillEntry(entry.name, entry.dirPath)),
  };
}

export function getLibrarySkill(
  libraryRoot: string | null,
  name: string,
): SkillDetail | null {
  if (!libraryRoot) return null;
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateSkillEntry(entry.name, entry.dirPath);
  const raw = readFileIfExists(entry.skillFile) ?? '';
  const { frontmatter, body } = parseSkillMd(raw);

  return {
    ...base,
    skillFile: entry.skillFile,
    skillName: stringFieldOrNull(frontmatter, 'name'),
    description: stringFieldOrNull(frontmatter, 'description'),
    bodyLength: body.length,
  };
}
