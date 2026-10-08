import { isAbortError, toFailure, type AuthResult, type AuthSession, type Clock, type ProfileHealth, type ProfileId, type RunCoordinator } from '@disco-lurk/core';
import type { LoginView } from './contract';
import type { ProfileGate } from './runs';
import { EventHub, HttpError } from './server';

/**
 * How long one headed wait lasts. The adapter's own poll decides when it gives up; this value only
 * drives the countdown the UI shows, so it must match that poll's ceiling.
 */
export const LOGIN_WAIT_MS = 300_000;

export interface LoginManagerDeps {
  coordinator: RunCoordinator;
  gate: ProfileGate;
  hub: EventHub;
  clock: Clock;
  /** The health check right after a sign-in; stores the result and refreshes discovered categories. */
  afterSignIn(health: ProfileHealth): Promise<void>;
}

interface Login {
  view: LoginView;
  session: AuthSession | null;
  wait: AbortController | null;
  release: () => void;
  /** The step in flight (opening, waiting, rechecking), so close() can let it unwind. */
  step: Promise<void>;
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
    const release = this.deps.gate.claim(profileId, 'sign-in');
    const l: Login = { view: { profileId, phase: 'opening' }, session: null, wait: null, release, step: Promise.resolve() };
    this.logins.set(profileId, l);
    this.publish(l, { phase: 'opening' });
    l.step = (async () => {
      try {
        l.session = await this.deps.coordinator.beginAuth(profileId);
      } catch (err) {
        release();
        this.publish(l, { phase: 'failed', message: describe(err) });
        return;
      }
      await this.waitOnce(l);
    })();
    return { ...l.view };
  }

  private async waitOnce(l: Login): Promise<void> {
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
      if (l.view.phase === 'closed' || interrupt?.aborted) return;
      // The person closed the browser window: the sign-in is over and the Profile is free again.
      if (isAbortError(err)) return this.finish(l, 'closed');
      return this.finish(l, 'failed', describe(err));
    }
    if (result.status === 'authenticated') return this.signedIn(l, result.username);
    this.publish(l, { phase: result.status === 'challenge-detected' ? 'challenge-detected' : 'needs-auth' });
  }

  private async signedIn(l: Login, username: string | undefined) {
    await l.session?.close().catch(() => {});
    l.session = null;
    this.publish(l, { phase: 'checking-health', ...(username ? { username } : {}) });
    try {
      const health = await this.deps.coordinator.inspect(l.view.profileId);
      await this.deps.afterSignIn(health);
      this.publish(l, { phase: 'done', ...(username ? { username } : {}), health });
    } catch (err) {
      this.publish(l, { phase: 'done', ...(username ? { username } : {}), message: describe(err) });
    } finally {
      l.release();
    }
  }

  private async finish(l: Login, phase: 'closed' | 'failed', message?: string) {
    l.wait?.abort();
    const session = l.session;
    l.session = null;
    await session?.close().catch(() => {});
    l.release();
    this.publish(l, { phase, ...(message ? { message } : {}) });
  }

  recheck(profileId: ProfileId): LoginView {
    const l = this.live(profileId);
    if (l.view.phase === 'waiting') l.wait?.abort();
    l.step = l.step.then(() => this.settle(l, () => l.session!.recheck()));
    return { ...l.view };
  }

  continue(profileId: ProfileId): LoginView {
    const l = this.live(profileId);
    if (l.view.phase === 'waiting') return { ...l.view };
    l.step = l.step.then(() => this.waitOnce(l));
    return { ...l.view };
  }

  async close(profileId: ProfileId): Promise<LoginView> {
    const l = this.logins.get(profileId);
    if (!l) throw new HttpError(404, 'no-login', `No sign-in for ${profileId}`);
    if (l.view.phase !== 'done' && l.view.phase !== 'failed' && l.view.phase !== 'closed') await this.finish(l, 'closed');
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
