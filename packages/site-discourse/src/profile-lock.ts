import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentLockOwner, lockOwnerLive, markLockHeld, markLockReleased, type LivenessProbe, type LockOwner } from '@disco-lurk/config';
import { RunError } from '@disco-lurk/core';

export const LOCK_FILE = '.lurk-lock';

/** Lock file contents. */
export interface LockInfo extends LockOwner {
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
  probe?: LivenessProbe;
}

/** Whether the lock at `path` still belongs to a running owner; see `lockOwnerLive`. */
export function profileLockLive(lock: LockInfo, path: string, probe?: LivenessProbe): Promise<boolean> {
  return lockOwnerLive(lock, path, probe);
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
 * One browser per Profile. An existing lock is cleared only after confirming its owner is gone
 * (`lockOwnerLive`); a live owner fails fast with `profile-locked` (the launch does not retry it).
 */
export async function acquireProfileLock(profileDir: string, runId: string, opts: LockOptions = {}): Promise<ProfileLock> {
  const path = join(profileDir, LOCK_FILE);
  // A stand-in PID (tests) carries no identity of this process.
  const owner: LockOwner = opts.pid === undefined ? await currentLockOwner() : { pid: opts.pid };
  const info: LockInfo = { ...owner, startedAt: new Date((opts.now ?? Date.now)()).toISOString(), runId };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(info), { flag: 'wx' });
      markLockHeld(path);
      return {
        path,
        info,
        async release() {
          markLockReleased(path);
          const current = await readLock(path);
          if (current?.pid === info.pid && current.runId === info.runId) await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readLock(path);
      if (holder && (await lockOwnerLive(holder, path, opts.probe))) {
        throw new RunError('profile-locked', `Profile is in use by PID ${holder.pid} (run ${holder.runId})`);
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new RunError('profile-locked', `Could not acquire ${path}`);
}
