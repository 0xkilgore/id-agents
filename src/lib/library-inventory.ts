// SPDX-License-Identifier: MIT
/**
 * Agent-config v3 slice 7 — read-only library inventory helpers.
 *
 * Thin wrappers around the slice-1 enumerators in `./agent-library.ts`
 * that produce JSON-friendly response shapes for manager HTTP routes.
 * No shape detection is duplicated here; all filesystem classification
 * stays in the enumerator.
 */

import fs from 'fs';
import path from 'path';
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
}

export interface AgentDetail extends AgentListEntry {
  /** Absolute path to the library entry directory. */
  dirPath: string;
  /** Absolute path to the persona / memory markdown file. */
  memoryFile: string;
}

export interface SkillListEntry {
  name: string;
}

export interface SkillDetail extends SkillListEntry {
  /** Absolute path to the skill directory. */
  dirPath: string;
  /** Absolute path to the SKILL.md file. */
  skillFile: string;
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

export function listLibraryAgents(libraryRoot: string | null): AgentListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [], errors: [] };
  }
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  return {
    libraryRoot,
    entries: scan.entries.map(entry => ({ name: entry.name, shape: entry.shape })),
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
  return {
    name: entry.name,
    shape: entry.shape,
    dirPath: entry.dirPath,
    memoryFile: entry.memoryFile,
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
    entries: entries.map(entry => ({ name: entry.name })),
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
  return {
    name: entry.name,
    dirPath: entry.dirPath,
    skillFile: entry.skillFile,
  };
}
