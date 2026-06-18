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
  listFilesystemArtifacts,
  registerArtifact,
  setArtifactAvailability,
  upsertArtifactSourceEvidence,
} from "./storage.js";

// Sentinel root meaning "the working directory itself" — scanned SHALLOW
// (top-level files only) so a project-ROOT artifact (the Cleveland Park
// one-pager lived at a project root, not in output/) is cataloged, without
// descending into code / node_modules.
export const ROOT_LEVEL = "." as const;

export const DEFAULT_FILESYSTEM_ARTIFACT_ROOTS = [
  ROOT_LEVEL, // project root (top-level files only)
  "output",
  "drafts",
  "reports",
  "transcripts",
  "completed",
  "content",
] as const;

export interface FilesystemArtifactRoot {
  agent: string;
  workingDirectory: string;
  roots?: readonly string[];
}

/** The default scan roots (project ROOT + named artifact dirs) — for introspection. */
export function artifactRootIds(): readonly string[] {
  return DEFAULT_FILESYSTEM_ARTIFACT_ROOTS;
}

export interface FilesystemArtifactReconcileOptions {
  roots: FilesystemArtifactRoot[];
  now?: () => Date;
  recentSinceMs?: number;
  maxFiles?: number;
  /** Sweep filesystem-cataloged artifacts whose file vanished -> availability
   *  'missing' (and restore 'present' if it reappears). Default true. The fix
   *  for "missing artifact shows 404". */
  markMissing?: boolean;
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
  /** Artifacts flipped to availability='missing' this pass. */
  marked_missing: number;
  /** Artifacts restored to availability='present' (file reappeared). */
  restored_present: number;
}

/** Top-level files of a directory (no recursion) — for project-ROOT scanning. */
function shallowFiles(dir: string, maxFiles: number, out: string[]): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (!entry.isFile()) continue;
    const abs = path.join(dir, entry.name);
    try {
      if (lstatSync(abs).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push(abs);
  }
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
    marked_missing: 0,
    restored_present: 0,
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
      // Project-ROOT: shallow (top-level files only) so we never descend into
      // code / node_modules. Named subdirs: recursive (they are artifact dirs).
      if (rootName === ROOT_LEVEL) {
        shallowFiles(rootDir, maxFiles - result.files_seen, files);
      } else {
        walkFiles(rootDir, maxFiles - result.files_seen, files);
      }
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
            tag: rootName === ROOT_LEVEL ? "root" : rootName,
            abs_path: absPath,
            produced_at: new Date(st.mtimeMs).toISOString(),
            source: "filesystem",
            availability: "present",
            reconciled_at: nowIso,
          },
          nowIso,
        );
        if (reg.inserted) result.inserted++;
        else result.updated++;
        // A file that was cataloged 'missing' and is now on disk is restored.
        if (existing?.availability === "missing") result.restored_present++;

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

  // Missing-sweep (the "missing artifact shows 404" fix): a filesystem-cataloged
  // artifact whose file vanished becomes availability='missing' instead of
  // 404ing; one that reappears is restored to 'present'.
  if (opts.markMissing !== false) {
    const cataloged = await listFilesystemArtifacts(adapter);
    for (const a of cataloged) {
      const present = existsSync(a.abs_path);
      if (present && a.availability === "missing") {
        await setArtifactAvailability(adapter, a.artifact_id, "present", nowIso);
        result.restored_present++;
      } else if (!present && a.availability !== "missing") {
        await setArtifactAvailability(adapter, a.artifact_id, "missing", nowIso);
        result.marked_missing++;
      }
    }
  }

  return result;
}
