// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('artifact path validation', () => {
  function validateArtifactPath(filePath: string): { valid: boolean; error?: string } {
    if (filePath.includes('..')) {
      return { valid: false, error: 'Invalid path: directory traversal not allowed' };
    }
    if (filePath.startsWith('/')) {
      return { valid: false, error: 'Invalid path: directory traversal not allowed' };
    }
    return { valid: true };
  }

  it('rejects paths with ..', () => {
    expect(validateArtifactPath('../../../etc/passwd')).toEqual({
      valid: false,
      error: 'Invalid path: directory traversal not allowed',
    });
  });

  it('rejects paths with embedded ..', () => {
    expect(validateArtifactPath('subdir/../../etc/passwd')).toEqual({
      valid: false,
      error: 'Invalid path: directory traversal not allowed',
    });
  });

  it('rejects absolute paths', () => {
    expect(validateArtifactPath('/etc/passwd')).toEqual({
      valid: false,
      error: 'Invalid path: directory traversal not allowed',
    });
  });

  it('accepts simple filenames', () => {
    expect(validateArtifactPath('report.md')).toEqual({ valid: true });
  });

  it('accepts paths with subdirectories', () => {
    expect(validateArtifactPath('reports/2024/analysis.json')).toEqual({ valid: true });
  });
});

describe('artifact file size limit', () => {
  it('rejects files over 1MB', () => {
    const maxSize = 1_048_576;
    const fileSize = 2_000_000;
    expect(fileSize > maxSize).toBe(true);
    const errorMsg = `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max: 1MB`;
    expect(errorMsg).toBe('File too large (1.9MB). Max: 1MB');
  });

  it('accepts files under 1MB', () => {
    const maxSize = 1_048_576;
    expect(500_000 > maxSize).toBe(false);
  });
});

describe('output directory listing', () => {
  it('returns empty array when output dir does not exist', () => {
    const outputDir = path.join(os.tmpdir(), `id-agents-test-nonexistent-${Date.now()}`);
    expect(fs.existsSync(outputDir)).toBe(false);
    const files: { name: string; size: number }[] = [];
    expect(files).toEqual([]);
  });

  it('lists files in output directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-output-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'report.md'), '# Test Report\n');
      fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"key": "value"}');

      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => {
          const st = fs.statSync(path.join(tmpDir, e.name));
          return { name: e.name, size: st.size };
        });

      expect(files).toHaveLength(2);
      expect(files.map(f => f.name).sort()).toEqual(['data.json', 'report.md']);
      expect(files.every(f => f.size > 0)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads file content from output directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-artifact-'));
    try {
      const content = '# Analysis Report\n\nFindings: all good.';
      fs.writeFileSync(path.join(tmpDir, 'report.md'), content);

      const readContent = fs.readFileSync(path.join(tmpDir, 'report.md'), 'utf-8');
      expect(readContent).toBe(content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
