// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentSpec } from '../config-parser.js';
import {
  parseTeamConfig,
  resolveConfigLibraryRoot,
} from '../config-parser.js';
import { enumerateLibraryAgents, type LibraryAgentEntry } from '../lib/agent-library.js';
import { resolveRuntime } from '../runtime/registry.js';

const RECEIPT_VERSION = 1;
const SKIPPED_SOURCE_BASENAMES = new Set(['README.md', 'LICENSE']);

export interface SyncReceiptEntry {
  sha256: string;
  source: string;
}

export interface SyncReceipt {
  version: number;
  lastDeployedAt: string;
  files: Record<string, SyncReceiptEntry>;
}

export interface SyncFileResult {
  path: string;
  case: 1 | 2 | 3 | 4;
}

export interface SyncWorkspaceResult {
  workspacePath: string;
  receiptPath: string;
  files: SyncFileResult[];
  warnings: string[];
  counts: {
    wroteMissing: number;
    matchedSource: number;
    overwroteManaged: number;
    drifted: number;
  };
}

export interface SyncWorkspaceOptions {
  configPath: string;
  libraryRoot?: string;
  workspacePath?: string;
}

type RuntimeClass = 'claude' | 'codex' | 'cursor';

function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function toPortableRelativePath(p: string): string {
  return p.split(path.sep).join('/');
}

function expandHomeDir(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Classify an AgentSpec runtime into the coarse target-mapping families used
 * by slice-5 remap rules. Unknown or remote-endpoint runtimes return null.
 */
function classifyRuntime(runtime: AgentSpec['runtime']): RuntimeClass | null {
  const resolved = resolveRuntime(runtime);
  if (resolved === 'claude-agent-sdk' || resolved === 'claude-code-cli' || resolved === 'claude-code-local') {
    return 'claude';
  }
  if (resolved === 'codex') return 'codex';
  if (resolved === 'cursor-cli') return 'cursor';
  return null;
}

function loadReceipt(receiptPath: string): SyncReceipt {
  if (!fs.existsSync(receiptPath)) {
    return { version: RECEIPT_VERSION, lastDeployedAt: '', files: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as Partial<SyncReceipt>;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : RECEIPT_VERSION,
    lastDeployedAt: typeof parsed.lastDeployedAt === 'string' ? parsed.lastDeployedAt : '',
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
  };
}

function writeReceiptAtomic(receiptPath: string, receipt: SyncReceipt): void {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.renameSync(tempPath, receiptPath);
}

interface SourceFile {
  absolutePath: string;
  /**
   * Canonical relative path as if the library entry were always claude-native.
   *
   * - claude-native:    walked directly from dirPath; CLAUDE.md appears at 'CLAUDE.md'.
   * - agents-md-native: walked from dirPath (which does not contain CLAUDE.md) AND the
   *                     sibling `<name>.md` is injected with a virtual relativePath of
   *                     'CLAUDE.md' so the rest of the pipeline is shape-agnostic.
   */
  relativePath: string;
}

function walkDirectory(rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (currentDir: string, prefix: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (SKIPPED_SOURCE_BASENAMES.has(entry.name)) continue;

      files.push({ absolutePath, relativePath: toPortableRelativePath(relativePath) });
    }
  };

  walk(rootDir, '');
  return files;
}

/**
 * Produce the canonical source-file list for a library entry. For both
 * native shapes the caller gets a list rooted at a claude-native layout:
 * `CLAUDE.md` at the top, plus optional `skills/`, `agents/`, `commands/`,
 * `rules/`, `hooks/`, `settings.json`, and arbitrary nested files.
 */
function listSourceFilesForEntry(entry: LibraryAgentEntry): SourceFile[] {
  const files = walkDirectory(entry.dirPath);
  if (entry.shape === 'agents-md-native') {
    // Inject the sibling persona file as the canonical CLAUDE.md.
    files.push({ absolutePath: entry.memoryFile, relativePath: 'CLAUDE.md' });
  }
  // Stable ordering for determinism.
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

/**
 * Remap a canonical source-file relative path into the workspace-relative
 * target path for a given runtime. Returns null when the source should be
 * skipped for that runtime (e.g. Cursor dropping `skills/`).
 *
 * Mapping table (slice 5):
 *
 *   source               claude              codex                cursor
 *   -------------------- ------------------- -------------------- -------------------
 *   CLAUDE.md (root)     .claude/CLAUDE.md   AGENTS.md            AGENTS.md
 *   skills/<x>/...       .claude/skills/...  .agents/skills/...   (skip)
 *   agents/...           .claude/agents/...  (skip)               (skip)
 *   commands/...         .claude/commands/...(skip)               (skip)
 *   rules/<x>.md         .claude/rules/...   (skip)               .cursor/rules/<x>.mdc
 *   rules/... (non-.md)  .claude/rules/...   (skip)               (skip)
 *   hooks/...            .claude/hooks/...   (skip)               (skip)
 *   settings.json (root) .claude/settings.j  (skip)               (skip)
 *   anything else        .claude/<src>       (skip)               (skip)
 *
 * Claude-runtime sidecar rewrite for CLAUDE.md is applied later by the
 * caller, not here; this function only computes the primary target.
 */
function remapTarget(sourceRelativePath: string, runtime: RuntimeClass): string | null {
  const parts = sourceRelativePath.split('/');
  const first = parts[0];

  // Root persona file.
  if (parts.length === 1 && first === 'CLAUDE.md') {
    return runtime === 'claude' ? '.claude/CLAUDE.md' : 'AGENTS.md';
  }

  if (first === 'skills') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    if (runtime === 'codex') return `.agents/${sourceRelativePath}`;
    return null; // cursor skips skills
  }

  if (first === 'rules') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    if (runtime === 'cursor') {
      // Extension rename only, structure preserved. Non-.md files are skipped.
      if (!parts[parts.length - 1].endsWith('.md')) return null;
      const withoutMd = sourceRelativePath.slice(0, -'.md'.length);
      return `.cursor/${withoutMd}.mdc`;
    }
    return null; // codex skips rules
  }

  if (first === 'agents' || first === 'commands' || first === 'hooks') {
    if (runtime === 'claude') return `.claude/${sourceRelativePath}`;
    return null;
  }

  if (parts.length === 1 && first === 'settings.json') {
    return runtime === 'claude' ? '.claude/settings.json' : null;
  }

  // Passthrough for any other file: claude keeps it, codex/cursor drop it.
  return runtime === 'claude' ? `.claude/${sourceRelativePath}` : null;
}

function resolveSingleAgent(configPath: string): AgentSpec {
  const config = parseTeamConfig(configPath);
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error(`No agents defined in config: ${configPath}`);
  }
  if (config.agents.length !== 1) {
    throw new Error(`Workspace sync currently supports exactly one agent per config: ${configPath}`);
  }

  const agent = config.agents[0];
  if (!agent.agent) {
    throw new Error(`Agent "${agent.name}" is missing required agent: field`);
  }
  if (!agent.workingDirectory) {
    throw new Error(`Agent "${agent.name}" is missing required workingDirectory`);
  }
  if (classifyRuntime(agent.runtime) === null) {
    throw new Error(
      `Agent "${agent.name}" uses unsupported runtime for workspace sync: ${agent.runtime || 'default'}`,
    );
  }

  return agent;
}

export function syncWorkspaceFromConfig(options: SyncWorkspaceOptions): SyncWorkspaceResult {
  const configPath = path.resolve(options.configPath);
  const agent = resolveSingleAgent(configPath);
  const runtime = classifyRuntime(agent.runtime);
  if (runtime === null) {
    throw new Error(`Unsupported runtime for workspace sync: ${agent.runtime || 'default'}`);
  }
  const libraryRoot = path.resolve(options.libraryRoot || resolveConfigLibraryRoot(configPath));
  const workspacePath = path.resolve(expandHomeDir(options.workspacePath || agent.workingDirectory!));

  const scan = enumerateLibraryAgents(path.join(libraryRoot, 'agents'));
  if (scan.errors.length > 0) {
    throw new Error(scan.errors.map(error => error.message).join('; '));
  }

  const sourceEntry = scan.entries.find(entry => entry.name === agent.agent);
  if (!sourceEntry) {
    throw new Error(`Agent library entry not found: ${agent.agent}`);
  }

  fs.mkdirSync(workspacePath, { recursive: true });

  const receiptPath = path.join(workspacePath, '.id-agents', 'receipt.json');
  const previousReceipt = loadReceipt(receiptPath);

  // Refusal rule for Codex/Cursor: if the workspace already has an AGENTS.md
  // we never wrote, we must not silently sidecar or overwrite. Fail the sync
  // with zero writes and a clear recovery path.
  if (runtime === 'codex' || runtime === 'cursor') {
    const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
    if (fs.existsSync(agentsMdPath) && !previousReceipt.files['AGENTS.md']) {
      throw new Error(
        `Refusing to sync: workspace already has an AGENTS.md that is not tracked in the id-agents receipt. ` +
        `Remove ${agentsMdPath} and re-run sync, or manually merge the library persona into it and re-run ` +
        `once the workspace is quiescent.`,
      );
    }
  }

  const nextReceipt: SyncReceipt = {
    version: RECEIPT_VERSION,
    lastDeployedAt: new Date().toISOString(),
    files: { ...previousReceipt.files },
  };

  const results: SyncFileResult[] = [];
  const warnings: string[] = [];
  const counts = {
    wroteMissing: 0,
    matchedSource: 0,
    overwroteManaged: 0,
    drifted: 0,
  };

  // Pre-pass (Claude runtime only): decide whether to route the library's
  // root CLAUDE.md into the persona sidecar at .claude/rules/agent-<name>.md.
  // Sidecar fires only when a user-authored root CLAUDE.md is in the way
  // (file exists, no receipt entry for it, AND bytes differ from the source).
  // Every other state stays on the primary path so the main-loop 4-case
  // engine keeps slice-3/4 semantics.
  const claudePrimaryKey = toPortableRelativePath(path.join('.claude', 'CLAUDE.md'));
  const claudePrimaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
  const claudeSidecarKey = toPortableRelativePath(path.join('.claude', 'rules', `agent-${agent.agent}.md`));

  let useClaudeSidecar = false;
  if (
    runtime === 'claude' &&
    fs.existsSync(claudePrimaryPath) &&
    !previousReceipt.files[claudePrimaryKey]
  ) {
    const personaSourcePath =
      sourceEntry.shape === 'claude-native'
        ? path.join(sourceEntry.dirPath, 'CLAUDE.md')
        : sourceEntry.memoryFile;
    const sourceSha = sha256Hex(fs.readFileSync(personaSourcePath));
    const diskSha = sha256Hex(fs.readFileSync(claudePrimaryPath));
    useClaudeSidecar = diskSha !== sourceSha;
  }

  for (const sourceFile of listSourceFilesForEntry(sourceEntry)) {
    const primaryTargetRel = remapTarget(sourceFile.relativePath, runtime);
    if (primaryTargetRel === null) continue; // silently skipped per runtime

    const isRootPersona = sourceFile.relativePath === 'CLAUDE.md';
    const routedToSidecar = runtime === 'claude' && isRootPersona && useClaudeSidecar;
    const relativeTargetPath = routedToSidecar ? claudeSidecarKey : primaryTargetRel;
    const targetPath = path.join(workspacePath, relativeTargetPath);

    const sourceBytes = fs.readFileSync(sourceFile.absolutePath);
    const sourceSha = sha256Hex(sourceBytes);
    const receiptEntry = previousReceipt.files[relativeTargetPath];

    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sourceBytes);
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 1 });
      counts.wroteMissing += 1;
      continue;
    }

    const targetBytes = fs.readFileSync(targetPath);
    const targetSha = sha256Hex(targetBytes);

    if (targetSha === sourceSha) {
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 2 });
      counts.matchedSource += 1;
      continue;
    }

    if (receiptEntry && targetSha === receiptEntry.sha256) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sourceBytes);
      nextReceipt.files[relativeTargetPath] = {
        sha256: sourceSha,
        source: `agent:${agent.agent}`,
      };
      results.push({ path: relativeTargetPath, case: 3 });
      counts.overwroteManaged += 1;
      continue;
    }

    warnings.push(`Skipped drifted file: ${relativeTargetPath}`);
    if (receiptEntry) {
      nextReceipt.files[relativeTargetPath] = receiptEntry;
    }
    results.push({ path: relativeTargetPath, case: 4 });
    counts.drifted += 1;
  }

  writeReceiptAtomic(receiptPath, nextReceipt);

  return {
    workspacePath,
    receiptPath,
    files: results,
    warnings,
    counts,
  };
}

function parseSyncArgs(args: string[]): SyncWorkspaceOptions {
  if (args.length === 0) {
    throw new Error('Usage: id-agents sync <config> [--library-root <path>] [--workspace <path>]');
  }

  const options: SyncWorkspaceOptions = { configPath: args[0] };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--library-root') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --library-root');
      options.libraryRoot = value;
      i += 1;
      continue;
    }
    if (arg === '--workspace') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --workspace');
      options.workspacePath = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function maybeRunWorkspaceSyncCli(argv: string[]): Promise<number | null> {
  if (argv[0] !== 'sync') {
    return null;
  }

  try {
    const result = syncWorkspaceFromConfig(parseSyncArgs(argv.slice(1)));
    const total = result.files.length;
    console.log(`Synced ${total} files into ${result.workspacePath}`);
    console.log(
      `Case1=${result.counts.wroteMissing} ` +
      `Case2=${result.counts.matchedSource} ` +
      `Case3=${result.counts.overwroteManaged} ` +
      `Case4=${result.counts.drifted}`
    );
    console.log(`Receipt: ${result.receiptPath}`);
    for (const warning of result.warnings) {
      console.warn(`WARN ${warning}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
