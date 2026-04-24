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
import { enumerateLibraryAgents } from '../lib/agent-library.js';
import { getRuntimePaths, resolveRuntime } from '../runtime/registry.js';

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

function isClaudeRuntime(runtime: AgentSpec['runtime']): boolean {
  const resolved = resolveRuntime(runtime);
  return resolved === 'claude-agent-sdk' || resolved === 'claude-code-cli' || resolved === 'claude-code-local';
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

function listSourceFiles(rootDir: string): Array<{ absolutePath: string; relativePath: string }> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];

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

      files.push({ absolutePath, relativePath });
    }
  };

  walk(rootDir, '');
  return files;
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
  if (!isClaudeRuntime(agent.runtime)) {
    throw new Error(`Agent "${agent.name}" uses unsupported runtime for slice 3: ${agent.runtime || 'default'}`);
  }

  return agent;
}

export function syncWorkspaceFromConfig(options: SyncWorkspaceOptions): SyncWorkspaceResult {
  const configPath = path.resolve(options.configPath);
  const agent = resolveSingleAgent(configPath);
  const libraryRoot = path.resolve(options.libraryRoot || resolveConfigLibraryRoot(configPath));
  const workspacePath = path.resolve(expandHomeDir(options.workspacePath || agent.workingDirectory!));
  const runtimePaths = getRuntimePaths(agent.runtime);

  if (runtimePaths.overlayTarget !== '.claude') {
    throw new Error(`Slice 3 only supports Claude target mapping; got ${runtimePaths.overlayTarget}`);
  }

  const scan = enumerateLibraryAgents(path.join(libraryRoot, 'agents'));
  if (scan.errors.length > 0) {
    throw new Error(scan.errors.map(error => error.message).join('; '));
  }

  const sourceEntry = scan.entries.find(entry => entry.name === agent.agent);
  if (!sourceEntry) {
    throw new Error(`Agent library entry not found: ${agent.agent}`);
  }
  if (sourceEntry.shape !== 'claude-native') {
    throw new Error(`Slice 3 only supports claude-native library entries; got ${sourceEntry.shape}`);
  }

  fs.mkdirSync(workspacePath, { recursive: true });

  const receiptPath = path.join(workspacePath, '.id-agents', 'receipt.json');
  const previousReceipt = loadReceipt(receiptPath);
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

  // Pre-pass: decide how to route the library entry's top-level CLAUDE.md.
  // If the workspace already has .claude/CLAUDE.md that we do not own (no
  // receipt entry, or receipt SHA no longer matches disk), preserve it and
  // route our persona into the Claude rules sidecar instead.
  const claudePrimaryKey = toPortableRelativePath(path.join('.claude', 'CLAUDE.md'));
  const claudePrimaryPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
  const claudeSidecarKey = toPortableRelativePath(path.join('.claude', 'rules', `agent-${agent.agent}.md`));
  const claudeSidecarPath = path.join(workspacePath, '.claude', 'rules', `agent-${agent.agent}.md`);

  let useClaudeSidecar = false;
  if (fs.existsSync(claudePrimaryPath)) {
    const diskSha = sha256Hex(fs.readFileSync(claudePrimaryPath));
    const prior = previousReceipt.files[claudePrimaryKey];
    useClaudeSidecar = !prior || prior.sha256 !== diskSha;
  }

  // Switching to sidecar means we no longer own the primary file; drop any
  // stale receipt entry so the ownership ledger stays honest.
  if (useClaudeSidecar && nextReceipt.files[claudePrimaryKey]) {
    delete nextReceipt.files[claudePrimaryKey];
  }

  for (const sourceFile of listSourceFiles(sourceEntry.dirPath)) {
    const sourceBytes = fs.readFileSync(sourceFile.absolutePath);
    const sourceSha = sha256Hex(sourceBytes);
    const isRootClaudeMd = sourceFile.relativePath === 'CLAUDE.md';
    const routedToSidecar = isRootClaudeMd && useClaudeSidecar;
    const targetPath: string = routedToSidecar
      ? claudeSidecarPath
      : path.join(workspacePath, runtimePaths.overlayTarget, sourceFile.relativePath);
    const relativeTargetPath: string = routedToSidecar
      ? claudeSidecarKey
      : toPortableRelativePath(path.relative(workspacePath, targetPath));
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
