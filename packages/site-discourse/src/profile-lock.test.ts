import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireProfileLock, LOCK_FILE, profileLockLive } from './profile-lock';

const profile = () => mkdtempSync(join(tmpdir(), 'lurk-lock-'));

describe('Profile lock file (B02, §8.3)', () => {
  it('records PID, start time and run ID, and removes the file on release', async () => {
    const dir = profile();
    const lock = await acquireProfileLock(dir, 'run-1', { pid: 4242, now: () => Date.UTC(2026, 9, 8) });
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toEqual({
      pid: 4242,
      startedAt: '2026-10-08T00:00:00.000Z',
      runId: 'run-1',
    });
    await lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('refuses a Profile whose lock holder is still running', async () => {
    const dir = profile();
    await acquireProfileLock(dir, 'run-1', { pid: 1 });
    await expect(acquireProfileLock(dir, 'run-2', { probe: { isAlive: () => true } })).rejects.toMatchObject({ code: 'profile-locked' });
  });

  it('clears a lock only after confirming its process is gone', async () => {
    const dir = profile();
    await acquireProfileLock(dir, 'crashed', { pid: 999_999 });
    const lock = await acquireProfileLock(dir, 'run-2', { probe: { isAlive: (pid) => pid !== 999_999 } });
    expect(lock.info.runId).toBe('run-2');
  });

  it('records this process\'s host and start time, and clears a lock naming this PID that it does not hold', async () => {
    const dir = profile();
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: '', runId: 'before-restart' }));
    const lock = await acquireProfileLock(dir, 'run-1');
    expect(lock.info).toMatchObject({ pid: process.pid, hostname: hostname(), runId: 'run-1' });
    expect(typeof lock.info.processStartedAt).toBe('number');
    await expect(acquireProfileLock(dir, 'run-2')).rejects.toMatchObject({ code: 'profile-locked' });
    expect(await profileLockLive(lock.info, join(dir, LOCK_FILE))).toBe(true);
    await lock.release();
    expect(await profileLockLive(lock.info, join(dir, LOCK_FILE))).toBe(false);
  });

  it('clears a lock whose PID now belongs to a process that started later', async () => {
    const dir = profile();
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, hostname: hostname(), processStartedAt: 1_000, startedAt: '', runId: 'old' }));
    const lock = await acquireProfileLock(dir, 'run-2', { probe: { isAlive: () => true, startTime: async () => 9_000_000 } });
    expect(lock.info.runId).toBe('run-2');
  });

  it('release leaves a lock that now belongs to someone else', async () => {
    const dir = profile();
    const lock = await acquireProfileLock(dir, 'run-1', { pid: 10 });
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 11, startedAt: '', runId: 'other' }));
    await lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });
});
