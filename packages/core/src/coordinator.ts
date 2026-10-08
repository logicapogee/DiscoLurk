import { browse, toFailure } from './browse';
import {
  RunError,
  emptyStats,
  stopRequestOf,
  type RunEvent,
  type RunFailure,
  type RunOutcome,
  type RunResult,
  type RunState,
  type RunStats,
  type StopCause,
} from './events';
import type { LevelSnapshot, MetricKey } from './metrics';
import { mergeDiscoveredCategories } from './plan';
import type { AuthMode, AuthResult, AuthSession, ForumPort, RunCoordinator } from './ports';
import { isAbortError, seededRandom, type RuntimeDeps } from './runtime';
import type { BrowserMode, Category, Profile, ProfileHealth, ProfileId, RunPlanSnapshot, Site, SiteId } from './terms';

export interface ForumSession {
  forum: ForumPort;
  /** Closes the browser and releases the Profile lock. */
  close(): Promise<void>;
}

export interface OpenRequest {
  site: Site;
  profile: Profile;
  browserMode: BrowserMode;
  runId: string;
  /** Adapter-side observations that belong in the run's event stream. */
  warn(code: string, message: string): void;
}

/** Where a discovered site's category list is kept between runs (§7.1 step 2). */
export interface CategoryStore {
  load(siteId: SiteId): Promise<Category[]>;
  save(siteId: SiteId, categories: Category[]): Promise<void>;
}

export interface CoordinatorEnv {
  deps: RuntimeDeps;
  resolveProfile(profileId: ProfileId): Promise<{ profile: Profile; site: Site }>;
  /** Launches the Profile's browser; throws `RunError` (`browser-missing`, `profile-locked`, …) when it cannot. */
  open(request: OpenRequest): Promise<ForumSession>;
  categories: CategoryStore;
  /**
   * Aborts when the application exits. A user stop still verifies against the progress page;
   * this signal also cuts that verification short.
   */
  exitSignal?: AbortSignal;
}

/** S07 allows 10 s for the page itself; the rest covers navigation and the forced reload. */
export const VERIFY_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 60_000;

/**
 * Adapters report a browser that vanished under them (the user closed the window) as `cancelled`;
 * the run then ends without verification instead of failing on every later step.
 */
const browserGone = (failure: RunFailure | undefined) => failure?.code === 'cancelled';

/** One sign-in check that never waits for a person: credentials on password sites, otherwise a look at the page. */
function checkMode(site: Site, browserMode: BrowserMode): AuthMode {
  return site.login === 'password' && browserMode === 'headless' ? 'credentials' : 'headless-check';
}

/**
 * S08: the progress page's own numbers per metric key. `other` gathers several unrelated labels,
 * so it has no single value and is left to the snapshots in `RunResult.levels`.
 */
export function reportedMetrics(initial: LevelSnapshot | null, final: LevelSnapshot): NonNullable<RunStats['reported']> {
  const reported: NonNullable<RunStats['reported']> = {};
  for (const m of final.metrics) {
    if (m.key === 'other') continue;
    const before = initial?.metrics.find((i) => i.label === m.label);
    reported[m.key as Exclude<MetricKey, 'other'>] = before ? { initial: before.current, final: m.current } : { final: m.current };
  }
  return reported;
}

/** §6.1 / §6.2: the one kernel every entry point (CLI, server, scheduler) runs. */
export class DiscoLurkCoordinator implements RunCoordinator {
  constructor(private readonly env: CoordinatorEnv) {}

  async run(plan: RunPlanSnapshot, signal: AbortSignal, emit: (e: RunEvent) => void): Promise<RunResult> {
    // §9.1: the snapshot's seed fixes this run's choices, so the same snapshot replays the same picks.
    const deps: RuntimeDeps = { ...this.env.deps, random: seededRandom(plan.seed) };
    const at = () => new Date(deps.clock.now()).toISOString();
    const state = (s: RunState) => emit({ type: 'state', at: at(), state: s });
    const warn = (code: string, message: string) => emit({ type: 'warning', at: at(), code, message });
    let stats: RunStats = emptyStats();
    const levels: RunResult['levels'] = { initial: null, final: null };
    let baseline: RunResult['baseline'] = 'not-applicable';

    const end = (outcome: RunOutcome, stopCause: StopCause, failure?: RunFailure): RunResult => {
      if (failure) emit({ type: 'error', at: at(), error: failure });
      state(outcome);
      return { outcome, stopCause, stats, baseline, levels, ...(failure ? { failure } : {}) };
    };

    state('queued');
    state('launching');
    let site: Site;
    let session: ForumSession;
    try {
      const resolved = await this.env.resolveProfile(plan.profileId);
      site = resolved.site;
      if (site.id !== plan.siteId) throw new RunError('internal', `Profile ${plan.profileId} belongs to ${site.id}, not ${plan.siteId}`);
      if (plan.preset.categories.length === 0) throw new RunError('no-candidates', 'No category is enabled for this run');
      session = await this.env.open({ site, profile: resolved.profile, browserMode: plan.browserMode, runId: plan.id, warn });
    } catch (err) {
      return end('failed', 'error', toFailure(err));
    }
    const { forum } = session;

    try {
      if (signal.aborted) return end('cancelled', stopRequestOf(signal));

      try {
        const first = await forum.ensureAuthenticated(checkMode(site, plan.browserMode), signal);
        let auth: AuthResult = first;
        if (first.status === 'failed') return end(browserGone(first.failure) ? 'cancelled' : 'failed', 'error', first.failure);
        if (first.status !== 'authenticated') {
          state('awaiting_login');
          // B04/B05: only a headed window has a person who can finish signing in.
          if (plan.browserMode === 'headed') auth = await forum.ensureAuthenticated('headed-wait', signal);
          if (auth.status === 'challenge-detected') {
            state('challenge_detected');
            return end('failed', 'error', { code: 'challenge-detected', message: 'The site shows a challenge page; it is reported, never solved' });
          }
          if (auth.status === 'needs-auth') {
            state('needs_auth');
            return end('cancelled', 'error', { code: 'needs-auth', message: `Not signed in to ${site.displayName}; run \`lurk login --site ${site.id}\`` });
          }
          if (auth.status === 'failed') return end(browserGone(auth.failure) ? 'cancelled' : 'failed', 'error', auth.failure);
        }
      } catch (err) {
        if (isAbortError(err)) return end('cancelled', stopRequestOf(signal));
        const f = toFailure(err);
        return end(browserGone(f) ? 'cancelled' : 'failed', 'error', f);
      }

      state('reading_initial_progress');
      try {
        if (site.progressSource !== 'none') {
          try {
            levels.initial = await forum.readProgress('initial', signal);
            baseline = 'present';
          } catch (err) {
            if (isAbortError(err) || browserGone(toFailure(err))) throw err;
            baseline = 'missing';
            const f = toFailure(err);
            warn('baseline-missing', `Initial progress read failed (${f.code}: ${f.message}); continuing without a baseline`);
          }
        }
        if (site.categorySource === 'discovered') await this.refreshCategories(site, forum, signal, warn);
      } catch (err) {
        state('stopping');
        if (isAbortError(err)) return end('cancelled', stopRequestOf(signal));
        return end('cancelled', 'error', toFailure(err));
      }

      state('browsing');
      const out = await browse({ plan, forum, deps, signal, emit });
      stats = out.stats;

      let stopCause: StopCause;
      let failure: RunFailure | undefined;
      switch (out.end) {
        case 'target-reached':
          stopCause = 'target';
          break;
        case 'no-progress':
          state('no_progress');
          stopCause = 'no-progress';
          failure = { code: 'no-progress', message: 'A whole round entered no topic' };
          break;
        case 'cancelled':
          state('stopping');
          stopCause = stopRequestOf(signal);
          // The application is closing every browser (§10.4), so there is nothing left to verify with.
          if (stopCause === 'app-exit') return end('cancelled', stopCause);
          break;
        case 'error':
          state('stopping');
          stopCause = 'error';
          failure = out.failure;
          // §6.2 stopping → cancelled: with the browser gone nothing can be verified.
          if (browserGone(failure)) return end('cancelled', stopCause, failure);
          break;
      }

      state('verifying');
      if (site.progressSource !== 'none') {
        const verifySignal = AbortSignal.any([AbortSignal.timeout(VERIFY_TIMEOUT_MS), ...(this.env.exitSignal ? [this.env.exitSignal] : [])]);
        try {
          levels.final = await forum.readProgress('final', verifySignal);
          if (levels.final) stats.reported = reportedMetrics(levels.initial, levels.final);
        } catch (err) {
          if (this.env.exitSignal?.aborted) return end('cancelled', 'app-exit', failure);
          const f = toFailure(err);
          if (failure) warn('final-progress-failed', `${f.code}: ${f.message}`);
          else failure = isAbortError(err) ? { code: 'page-timeout', message: 'Final progress read timed out' } : f;
        }
      }
      emit({ type: 'stats', at: at(), stats: structuredClone(stats) });
      return end(failure ? 'failed' : 'completed', stopCause, failure);
    } finally {
      await session.close();
    }
  }

  async inspect(profileId: ProfileId): Promise<ProfileHealth> {
    const checkedAt = () => new Date(this.env.deps.clock.now()).toISOString();
    const { profile, site } = await this.env.resolveProfile(profileId);
    let session: ForumSession;
    try {
      session = await this.env.open({ site, profile, browserMode: 'headless', runId: `inspect-${this.env.deps.clock.now()}`, warn: () => {} });
    } catch (err) {
      const locked = err instanceof RunError && err.code === 'profile-locked';
      return { profileId, status: locked ? 'locked' : 'broken', checkedAt: checkedAt() };
    }
    try {
      const signal = AbortSignal.timeout(INSPECT_TIMEOUT_MS);
      const auth = await session.forum.ensureAuthenticated(checkMode(site, 'headless'), signal);
      if (auth.status !== 'authenticated') {
        return { profileId, status: auth.status === 'failed' ? 'broken' : 'needs-auth', checkedAt: checkedAt() };
      }
      // §8.2 step 7: the health check is where a discovered site reads its categories.
      if (site.categorySource === 'discovered') await this.refreshCategories(site, session.forum, signal, () => {});
      return { profileId, status: 'ready', ...(auth.username ? { username: auth.username } : {}), checkedAt: checkedAt() };
    } finally {
      await session.close();
    }
  }

  async beginAuth(profileId: ProfileId): Promise<AuthSession> {
    const { profile, site } = await this.env.resolveProfile(profileId);
    const session = await this.env.open({ site, profile, browserMode: 'headed', runId: `auth-${this.env.deps.clock.now()}`, warn: () => {} });
    return {
      recheck: () => session.forum.ensureAuthenticated('headless-check', AbortSignal.timeout(INSPECT_TIMEOUT_MS)),
      continueWaiting: (signal) => session.forum.ensureAuthenticated('headed-wait', signal),
      close: () => session.close(),
    };
  }

  /** §7.2: a discovered site re-reads its categories after every sign-in; a failed read keeps the stored list. */
  private async refreshCategories(site: Site, forum: ForumPort, signal: AbortSignal, warn: (code: string, message: string) => void) {
    try {
      const found = await forum.discoverCategories(signal);
      if (found.length === 0) {
        warn('category-discovery-empty', 'The categories page listed no category');
        return;
      }
      const known = await this.env.categories.load(site.id);
      await this.env.categories.save(site.id, mergeDiscoveredCategories(known, found));
    } catch (err) {
      if (isAbortError(err) || browserGone(toFailure(err))) throw err;
      const f = toFailure(err);
      warn('category-discovery-failed', `${f.code}: ${f.message}`);
    }
  }
}
