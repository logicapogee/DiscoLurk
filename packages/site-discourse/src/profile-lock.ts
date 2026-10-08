import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunError } from '@disco-lurk/core';

export const LOCK_FILE = '.lurk-lock';

/** §8.3 lock file contents. */
export interface LockInfo {
  pid: number;
  startedAt: string;
  runId: string;
}

export interface ProfileLock {
  readonly path: string;
  readonly info: LockInfo;
  release(): Promise<void>;
}

export interface LockOptions {
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

/** EPERM means the process exists but belongs to someone else, which still makes the lock live. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file's contents; null when it is missing or unreadable. */
export async function readLock(path: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * B02: one browser per Profile. An existing lock is cleared only after confirming its process is
 * gone; a live owner fails fast with `profile-locked` (B03 does not retry it).
 */
export async function acquireProfileLock(profileDir: string, runId: string, opts: LockOptions = {}): Promise<ProfileLock> {
  const path = join(profileDir, LOCK_FILE);
  const info: LockInfo = {
    pid: opts.pid ?? process.pid,
    startedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    runId,
  };
  const isAlive = opts.isAlive ?? processAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(info), { flag: 'wx' });
      return {
        path,
        info,
        async release() {
          const current = await readLock(path);
          if (current?.pid === info.pid && current.runId === info.runId) await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readLock(path);
      if (holder && isAlive(holder.pid)) {
        throw new RunError('profile-locked', `Profile is in use by PID ${holder.pid} (run ${holder.runId})`);
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new RunError('profile-locked', `Could not acquire ${path}`);
}
