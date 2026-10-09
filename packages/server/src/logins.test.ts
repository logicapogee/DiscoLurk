import type { AuthSession, ProfileHealth, RunCoordinator } from '@disco-lurk/core';
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
  const recorded: ProfileHealth[] = [];
  const gate = new ProfileGate();
  const hub = new EventHub();
  const phases: string[] = [];
  hub.subscribe((f) => f.type === 'login' && phases.push(f.login.phase));
  const coordinator = { beginAuth: () => opening.promise } as unknown as RunCoordinator;
  const logins = new LoginManager({
    coordinator,
    gate,
    hub,
    clock: { now: () => 0, monotonic: () => 0 },
    afterSignIn: async (health) => {
      recorded.push(health);
      log.push(`health ${health.status}`);
    },
    // What the app publishes here is the Profile list, so the gate must already be open.
    released: async (id) => void log.push(`released busy=${gate.isBusy(id)}`),
  });
  return { opening, log, gate, phases, logins, recorded };
}

describe('LoginManager closing', () => {
  it('closes a window that finishes opening after the sign-in was closed', async () => {
    const { opening, log, gate, phases, logins } = setup();
    logins.start('fx/main');
    const closing = logins.close('fx/main');
    await new Promise((r) => setTimeout(r, 0));
    // Chrome is still starting on this Profile, so nobody else may claim it yet.
    expect(gate.isBusy('fx/main')).toBe(true);
    opening.resolve(session(log));
    expect((await closing).phase).toBe('closed');
    expect(log).toEqual(['session closed', 'released busy=false']);
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
    expect(log).toEqual(['session closed', 'released busy=false']);
    expect(logins.get('fx/main')?.phase).toBe('closed');
  });
});

describe('LoginManager after the health check', () => {
  const signedIn = (log: string[], inspect: AuthSession['inspect']): AuthSession =>
    ({ ...session(log), recheck: async () => ({ status: 'authenticated' }), inspect }) as AuthSession;

  async function finishSignIn(inspect: AuthSession['inspect']) {
    const t = setup();
    t.logins.start('fx/main');
    t.opening.resolve(signedIn(t.log, inspect));
    await new Promise((r) => setTimeout(r, 0));
    t.logins.recheck('fx/main');
    while (t.logins.get('fx/main')?.phase !== 'done') await new Promise((r) => setTimeout(r, 0));
    return t;
  }

  it('closes the window and frees the Profile once the check passes, after storing its result', async () => {
    const health: ProfileHealth = { profileId: 'fx/main', status: 'ready', username: 'alice', checkedAt: '' };
    const t = await finishSignIn(async () => health);
    expect(t.gate.isBusy('fx/main')).toBe(false);
    expect(t.log).toEqual(['health ready', 'session closed', 'released busy=false']);
    expect(t.recorded).toEqual([health]);
    expect(t.logins.get('fx/main')).toMatchObject({ phase: 'done', health });
    expect(t.phases.slice(-2)).toEqual(['checking-health', 'done']);
  });

  it('closes the window and frees the Profile when the check fails, keeping why', async () => {
    const t = await finishSignIn(async () => {
      throw new Error('page gone');
    });
    expect(t.gate.isBusy('fx/main')).toBe(false);
    expect(t.log).toEqual(['session closed', 'released busy=false']);
    expect(t.logins.get('fx/main')).toMatchObject({ phase: 'done', message: expect.stringContaining('page gone') });
  });
});
