import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Write-then-rename so readers never observe a half-written file.
// rename(2) is atomic within the same filesystem; both files live under
// env.dataDir which is a single Docker volume, so this holds.
export function atomicWriteFile(file: string, data: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function atomicWriteJson(file: string, data: unknown): void {
  atomicWriteFile(file, JSON.stringify(data, null, 2));
}
