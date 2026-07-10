// SPDX-License-Identifier: MIT

import { existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

function lockAgeMs(lockFile, nowMs) {
  try {
    return Math.max(0, nowMs - statSync(lockFile).mtimeMs);
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function readLockInfo(lockFile) {
  try {
    const body = readFileSync(lockFile, 'utf8').trim();
    if (!body) return { parseable: false, pid: null };
    const parsed = JSON.parse(body);
    return {
      parseable: true,
      pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
      startedAt: typeof parsed?.startedAt === 'string' ? parsed.startedAt : null,
    };
  } catch {
    return { parseable: false, pid: null };
  }
}

export function shouldBreakWatchdogLock({
  lockFile,
  nowMs = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  processAlive = isProcessAlive,
}) {
  if (!existsSync(lockFile)) {
    return { breakLock: false, reason: 'lock missing' };
  }

  const age = lockAgeMs(lockFile, nowMs);
  if (age === null || age < staleMs) {
    return { breakLock: false, reason: age === null ? 'lock disappeared' : `lock age ${age}ms < stale threshold ${staleMs}ms` };
  }

  const info = readLockInfo(lockFile);
  if (info.pid !== null && processAlive(info.pid)) {
    return { breakLock: false, reason: `lock held by live pid ${info.pid}` };
  }

  return {
    breakLock: true,
    reason: info.pid === null
      ? `stale ${info.parseable ? 'pidless' : 'unparseable'} lock older than ${staleMs}ms`
      : `stale lock pid ${info.pid} is not running`,
  };
}

export function writeWatchdogLock(lockFile, fd, metadata = {}) {
  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...metadata,
  }));
}

export function acquireWatchdogLock({
  lockFile,
  staleMs = DEFAULT_LOCK_STALE_MS,
  log = () => {},
  nowMs = Date.now(),
  processAlive = isProcessAlive,
}) {
  try {
    const fd = openSync(lockFile, 'wx');
    writeWatchdogLock(lockFile, fd);
    return { fd, acquired: true, brokeStaleLock: false };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const stale = shouldBreakWatchdogLock({ lockFile, nowMs, staleMs, processAlive });
  if (!stale.breakLock) {
    log(`another deploy watchdog run is active; lock exists at ${lockFile} (${stale.reason})`);
    return { fd: null, acquired: false, brokeStaleLock: false };
  }

  log(`breaking stale deploy watchdog lock at ${lockFile}: ${stale.reason}`);
  unlinkSync(lockFile);
  const fd = openSync(lockFile, 'wx');
  writeWatchdogLock(lockFile, fd, { brokeStaleLock: true, staleReason: stale.reason });
  return { fd, acquired: true, brokeStaleLock: true };
}
