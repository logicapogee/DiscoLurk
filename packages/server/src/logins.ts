import { isAbortError, LOGIN_WAIT_MS, toFailure, type AuthResult, type AuthSession, type Clock, type ProfileHealth, type ProfileId, type RunCoordinator } from '@disco-lurk/core';
import type { LoginView } from './contract';
import type { ProfileGate } from './runs';
import { EventHub, HttpError } from './hub';

interface LoginManagerDeps {
  coordinator: RunCoordinator;
  gate: ProfileGate;
  hub: EventHub;
  clock: Clock;
  /** Stores the health read right after a sign-in and refreshes discovered categories. */
  afterSignIn(health: ProfileHealth): Promise<void>;
  /** Hears that the Profile is free again, so clients can be told it is no longer in use. */
  released(profileId: ProfileId): Promise<void>;
}

interface Login {
  view: LoginView;
  session: AuthSession | null;
  wait: AbortController | null;
  release: () => Promise<void>;
  /** The step in flight (opening, waiting, rechecking), so close() can let it unwind. */
  step: Promise<void>;
  /** Set by close(); a step that resumes afterwards closes whatever it opened and stops. */
  closed: boolean;
}

/**
 * A headed sign-in: the browser stays open across `needs-auth` so the person can finish; recheck,
 * continue and close act on that same window. Only one per Profile, and never beside a run.
 */
export class LoginManager {
  private logins = new Map<ProfileId, Login>();

  constructor(private readonly deps: LoginManagerDeps) {}

  list(): LoginView[] {
    return [...this.logins.values()].map((l) => ({ ...l.view }));
  }

  get(profileId: ProfileId): LoginView | undefined {
    const l = this.logins.get(profileId);
    return l ? { ...l.view } : undefined;
  }

  private publish(l: Login, patch: Partial<LoginView>) {
    const { deadline: _d, message: _m, ...rest } = l.view;
    l.view = { ...rest, ...patch };
    this.deps.hub.publish({ type: 'login', login: { ...l.view } });
  }

  private live(profileId: ProfileId): Login {
    const l = this.logins.get(profileId);
    if (!l || !l.session) throw new HttpError(409, 'no-login', `No sign-in window is open for ${profileId}`);
    return l;
  }

  start(profileId: ProfileId): LoginView {
    const existing = this.logins.get(profileId);
    if (existing && !['done', 'failed', 'closed'].includes(existing.view.phase)) return { ...existing.view };
    const unclaim = this.deps.gate.claim(profileId, 'sign-in');
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      unclaim();
      await this.deps.released(profileId).catch(() => {});
    };
    const l: Login = { view: { profileId, phase: 'opening' }, session: null, wait: null, release, step: Promise.resolve(), closed: false };
    this.logins.set(profileId, l);
    this.publish(l, { phase: 'opening' });
    l.step = (async () => {
      let session: AuthSession;
      try {
        session = await this.deps.coordinator.beginAuth(profileId);
      } catch (err) {
        await release();
        if (!l.closed) this.publish(l, { phase: 'failed', message: describe(err) });
        return;
      }
      // The window opened after the sign-in was closed: nobody is left to use it.
      if (l.closed) {
        await session.close().catch(() => {});
        return await release();
      }
      l.session = session;
      await this.waitOnce(l);
    })();
    return { ...l.view };
  }

  private async waitOnce(l: Login): Promise<void> {
    if (l.closed || !l.session) return;
    const wait = new AbortController();
    l.wait = wait;
    this.publish(l, { phase: 'waiting', deadline: this.deps.clock.now() + LOGIN_WAIT_MS });
    await this.settle(l, () => l.session!.continueWaiting(wait.signal), wait.signal);
  }

  /** `interrupt` aborts when recheck or close cut the step short; that is not the window closing. */
  private async settle(l: Login, step: () => Promise<AuthResult>, interrupt?: AbortSignal): Promise<void> {
    let result: AuthResult;
    try {
      result = await step();
    } catch (err) {
      if (l.closed || l.view.phase === 'closed' || interrupt?.aborted) return;
      // The person closed the browser window: the sign-in is over and the Profile is free again.
      if (isAbortError(err)) return this.finish(l, 'closed');
      return this.finish(l, 'failed', describe(err));
    }
    if (l.closed) return;
    if (result.status === 'authenticated') return this.signedIn(l);
    this.publish(l, { phase: result.status === 'challenge-detected' ? 'challenge-detected' : 'needs-auth' });
  }

  /**
   * The health check runs in the signed-in window, the same way `lurk login` verifies a sign-in.
   * Its result is stored before the window closes, so the Profile is announced free together with it;
   * a close() during the check has already closed the window and released the Profile.
   */
  private async signedIn(l: Login) {
    const session = l.session!;
    this.publish(l, { phase: 'checking-health' });
    let outcome: Partial<LoginView>;
    try {
      const health = await session.inspect();
      await this.deps.afterSignIn(health);
      outcome = { health };
    } catch (err) {
      outcome = { message: describe(err) };
    }
    if (l.session === session) {
      l.session = null;
      await session.close().catch(() => {});
      await l.release();
    }
    if (!l.closed) this.publish(l, { phase: 'done', ...outcome });
  }

  /**
   * The Profile is released by whoever closes its browser: here when a window is open, otherwise
   * by the opening step in `start`, which closes the window that is still on its way.
   */
  private async finish(l: Login, phase: 'closed' | 'failed', message?: string) {
    l.wait?.abort();
    const session = l.session;
    l.session = null;
    if (session) {
      await session.close().catch(() => {});
      await l.release();
    }
    this.publish(l, { phase, ...(message ? { message } : {}) });
  }

  recheck(profileId: ProfileId): LoginView {
    const l = this.live(profileId);
    if (l.view.phase === 'waiting') l.wait?.abort();
    l.step = l.step.then(() => (l.closed || !l.session ? undefined : this.settle(l, () => l.session!.recheck())));
    return { ...l.view };
  }

  continue(profileId: ProfileId): LoginView {
    const l = this.live(profileId);
    if (l.view.phase === 'waiting') return { ...l.view };
    l.step = l.step.then(() => this.waitOnce(l));
    return { ...l.view };
  }

  /** Closes the window and waits for the step in flight to unwind, so no browser outlives the call. */
  async close(profileId: ProfileId): Promise<LoginView> {
    const l = this.logins.get(profileId);
    if (!l) throw new HttpError(404, 'no-login', `No sign-in for ${profileId}`);
    if (l.view.phase !== 'done' && l.view.phase !== 'failed' && l.view.phase !== 'closed') {
      l.closed = true;
      await this.finish(l, 'closed');
    }
    await l.step.catch(() => {});
    return { ...l.view };
  }

  /** Closes every sign-in window; the app is exiting, so a kept window has nobody left to use it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.logins.keys()].map((id) => this.close(id).catch(() => {})));
  }
}

function describe(err: unknown): string {
  const f = toFailure(err);
  return `${f.code}: ${f.message}`;
}
