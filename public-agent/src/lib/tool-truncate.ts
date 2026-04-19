import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFile } from './atomic.js';

// Per-tool-call output cap applied to read_knowledge. search_knowledge
// snippets are already bounded by KNOWLEDGE_SNIPPET_CHARS (120) so they
// don't flow through here.
export const TOOL_OUTPUT_MAX_LINES = 2000;
export const TOOL_OUTPUT_MAX_BYTES = 50_000;
export const TOOL_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function artifactDir(dataDir: string): string {
  return path.join(dataDir, 'tool-artifacts');
}

function buildArtifactName(fileId: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const tag = crypto.randomBytes(3).toString('hex');
  const slug = fileId.replace(/[^a-z0-9-]/gi, '_').slice(0, 64);
  return `${iso}-${tag}-${slug}.txt`;
}

export interface TruncatedResult {
  content: string;
  truncated: boolean;
  artifact?: string;
  originalBytes: number;
  originalLines: number;
}

// Caps read_knowledge content at MAX_LINES or MAX_BYTES (whichever fires
// first). On truncation persists the full text to the artifact dir and
// replaces the in-band payload with a preview plus a `<truncated ...>`
// marker that tells the model where the full content went.
export function truncateToolContent(
  dataDir: string,
  fileId: string,
  raw: string,
): TruncatedResult {
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  const originalLines = raw === '' ? 0 : raw.split('\n').length;
  const overByBytes = originalBytes > TOOL_OUTPUT_MAX_BYTES;
  const overByLines = originalLines > TOOL_OUTPUT_MAX_LINES;

  if (!overByBytes && !overByLines) {
    return { content: raw, truncated: false, originalBytes, originalLines };
  }

  const name = buildArtifactName(fileId);
  const absPath = path.join(artifactDir(dataDir), name);
  try {
    atomicWriteFile(absPath, raw);
  } catch (err) {
    // Artifact write failures shouldn't block the LLM response; surface
    // the marker anyway so the model knows the cut happened, and note
    // that no artifact was persisted.
    console.error('[public-agent] tool-truncate artifact write failed:', err);
    return {
      content:
        slicePreview(raw) +
        `\n<truncated file_id="${fileId}" bytes="${originalBytes}" lines="${originalLines}" artifact="unavailable" reason="write_failed">\n` +
        `Full content exceeded ${TOOL_OUTPUT_MAX_BYTES} bytes / ${TOOL_OUTPUT_MAX_LINES} lines and could not be persisted.\n` +
        `</truncated>`,
      truncated: true,
      originalBytes,
      originalLines,
    };
  }

  const preview = slicePreview(raw);
  const previewBytes = Buffer.byteLength(preview, 'utf8');
  const previewLines = preview === '' ? 0 : preview.split('\n').length;
  const marker =
    `\n<truncated file_id="${fileId}" bytes="${originalBytes}" lines="${originalLines}" artifact="${name}" ` +
    `preview_bytes="${previewBytes}" preview_lines="${previewLines}">\n` +
    `Full content persisted to the tool-artifacts directory. Ask for a different file_id or summarise what you have.\n` +
    `</truncated>`;
  return {
    content: preview + marker,
    truncated: true,
    artifact: name,
    originalBytes,
    originalLines,
  };
}

function slicePreview(raw: string): string {
  // Take the head only. Using lines first keeps the preview readable if the
  // file has many short lines; then apply the byte cap on top for safety.
  const lines = raw.split('\n');
  const headLines = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join('\n');
  if (Buffer.byteLength(headLines, 'utf8') <= TOOL_OUTPUT_MAX_BYTES) return headLines;
  // Walk back from MAX_BYTES in raw-string space. Buffer.byteLength is utf8
  // length, so work on a Buffer to slice at an exact byte boundary and then
  // trim any dangling partial multi-byte sequence.
  const buf = Buffer.from(headLines, 'utf8').subarray(0, TOOL_OUTPUT_MAX_BYTES);
  return buf.toString('utf8').replace(/\uFFFD+$/, '');
}

// Removes artifacts older than TOOL_ARTIFACT_RETENTION_MS. Idempotent and
// safe to call at boot; silently ignores missing directory and per-file
// errors so it can't take the server down.
export function purgeOldArtifacts(dataDir: string, now: number = Date.now()): { removed: number; kept: number } {
  const dir = artifactDir(dataDir);
  let removed = 0;
  let kept = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed, kept };
  }
  const cutoff = now - TOOL_ARTIFACT_RETENTION_MS;
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      kept += 1;
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      try {
        fs.unlinkSync(abs);
        removed += 1;
      } catch {
        // pass
      }
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}
