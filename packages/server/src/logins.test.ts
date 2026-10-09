import type { AuthSession, RunCoordinator } from '@disco-lurk/core';
import { describe, expect, it } from 'vitest';
import { LoginManager } from './logins';
import { ProfileGate } from './runs';
import { EventHub } from './hub';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function session(log: string[]): AuthSession {
  return {
    continueWaiting: (signal: AbortSignal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    recheck: async () => ({ status: 'needs-auth' }),
    inspect: async () => ({ profileId: 'fx/main', status: 'ready', checkedAt: '' }),
    close: async () => void log.push('session closed'),
  } as unknown as AuthSession;
}

function setup() {
  const opening = deferred<AuthSession>();
  const log: string[] = [];
  const gate = new ProfileGate();
  const hub = new EventHub();
  const phases: string[] = [];
  hub.subscribe((f) => f.type === 'login' && phases.push(f.login.phase));
  const coordinator = { beginAuth: () => opening.promise } as unknown as RunCoordinator;
  const logins = new LoginManager({ coordinator, gate, hub, clock: { now: () => 0, monotonic: () => 0 }, afterSignIn: async () => {} });
  return { opening, log, gate, phases, logins };
}

describe('LoginManager closing', () => {
  it('closes a window that finishes opening after the sign-in was closed', async () => {
    const { opening, log, gate, phases, logins } = setup();
    logins.start('fx/main');
    const closing = logins.close('fx/main');
    opening.resolve(session(log));
    expect((await closing).phase).toBe('closed');
    expect(log).toEqual(['session closed']);
    expect(gate.isBusy('fx/main')).toBe(false);
    expect(phases.at(-1)).toBe('closed');
    expect(phases).not.toContain('waiting');
  });

  it('closeAll waits until every window is closed', async () => {
    const { opening, log, logins } = setup();
    logins.start('fx/main');
    opening.resolve(session(log));
    await new Promise((r) => setTimeout(r, 0));
    expect(logins.get('fx/main')?.phase).toBe('waiting');
    await logins.closeAll();
    expect(log).toEqual(['session closed']);
    expect(logins.get('fx/main')?.phase).toBe('closed');
  });
});
