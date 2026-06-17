import path from "node:path";
import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  artifactIdFromPath,
  getArtifact,
  registerArtifact,
  upsertArtifactSourceEvidence,
} from "./storage.js";

export const DEFAULT_FILESYSTEM_ARTIFACT_ROOTS = [
  "output",
  "drafts",
  "reports",
  "transcripts",
] as const;

export interface FilesystemArtifactRoot {
  agent: string;
  workingDirectory: string;
  roots?: readonly string[];
}

export interface FilesystemArtifactReconcileOptions {
  roots: FilesystemArtifactRoot[];
  now?: () => Date;
  recentSinceMs?: number;
  maxFiles?: number;
}

export interface FilesystemArtifactReconcileResult {
  roots_seen: number;
  roots_scanned: number;
  files_seen: number;
  files_recent: number;
  inserted: number;
  updated: number;
  evidence_inserted: number;
  evidence_updated: number;
  skipped: number;
}

export function validateConsoleArtifactRelativePath(filePath: string): { ok: true } | { ok: false; error: string } {
  if (filePath.includes("..") || filePath.startsWith("/") || path.isAbsolute(filePath)) {
    return { ok: false, error: "Invalid path: directory traversal not allowed" };
  }
  return { ok: true };
}

function safeRootNames(root: FilesystemArtifactRoot): string[] {
  return [...(root.roots ?? DEFAULT_FILESYSTEM_ARTIFACT_ROOTS)].filter((name) => {
    if (!name || name.includes("..") || name.startsWith("/") || path.isAbsolute(name)) return false;
    return true;
  });
}

function isUnder(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function walkFiles(rootDir: string, maxFiles: number, out: string[]): void {
  if (out.length >= maxFiles) return;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const abs = path.join(rootDir, entry.name);
    let lst;
    try {
      lst = lstatSync(abs);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkFiles(abs, maxFiles, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export async function reconcileFilesystemArtifacts(
  adapter: DbAdapter,
  opts: FilesystemArtifactReconcileOptions,
): Promise<FilesystemArtifactReconcileResult> {
  const now = opts.now ?? (() => new Date());
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const maxFiles = opts.maxFiles ?? 5000;
  const result: FilesystemArtifactReconcileResult = {
    roots_seen: 0,
    roots_scanned: 0,
    files_seen: 0,
    files_recent: 0,
    inserted: 0,
    updated: 0,
    evidence_inserted: 0,
    evidence_updated: 0,
    skipped: 0,
  };

  for (const configuredRoot of opts.roots) {
    if (!configuredRoot.agent || !configuredRoot.workingDirectory) {
      result.skipped++;
      continue;
    }
    const workingDirectory = path.resolve(configuredRoot.workingDirectory);
    if (!existsSync(workingDirectory)) {
      result.skipped++;
      continue;
    }
    for (const rootName of safeRootNames(configuredRoot)) {
      result.roots_seen++;
      const rootDir = path.resolve(workingDirectory, rootName);
      if (!isUnder(workingDirectory, rootDir) || !existsSync(rootDir)) {
        result.skipped++;
        continue;
      }
      let rootStat;
      try {
        rootStat = lstatSync(rootDir);
      } catch {
        result.skipped++;
        continue;
      }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        result.skipped++;
        continue;
      }

      result.roots_scanned++;
      const files: string[] = [];
      walkFiles(rootDir, maxFiles - result.files_seen, files);
      for (const absPath of files) {
        if (result.files_seen >= maxFiles) break;
        result.files_seen++;
        const relToRoot = path.relative(rootDir, absPath);
        const safe = validateConsoleArtifactRelativePath(relToRoot);
        if (!safe.ok) {
          result.skipped++;
          continue;
        }
        if (!isUnder(rootDir, absPath)) {
          result.skipped++;
          continue;
        }
        let st;
        try {
          st = statSync(absPath);
        } catch {
          result.skipped++;
          continue;
        }
        if (!st.isFile()) {
          result.skipped++;
          continue;
        }
        if (opts.recentSinceMs !== undefined && st.mtimeMs < opts.recentSinceMs) {
          continue;
        }
        result.files_recent++;

        const artifactId = artifactIdFromPath(absPath);
        const existing = await getArtifact(adapter, artifactId);
        const reg = await registerArtifact(
          adapter,
          {
            basename: path.basename(absPath),
            agent: configuredRoot.agent,
            tag: rootName,
            abs_path: absPath,
            produced_at: new Date(st.mtimeMs).toISOString(),
            source: "filesystem",
            availability: "present",
          },
          nowIso,
        );
        if (reg.inserted) result.inserted++;
        else result.updated++;

        const sourceRef = `filesystem:${absPath}`;
        const evidence = await upsertArtifactSourceEvidence(
          adapter,
          {
            artifact_id: artifactId,
            source: "filesystem",
            source_ref: sourceRef,
            observed_at: nowIso,
            metadata_json: JSON.stringify({
              root: rootName,
              relative_path: relToRoot,
              size: st.size,
              mtime: new Date(st.mtimeMs).toISOString(),
              catalog_source_before: existing?.source ?? null,
            }),
          },
          nowIso,
        );
        if (evidence.inserted) result.evidence_inserted++;
        else result.evidence_updated++;
      }
    }
  }

  return result;
}
