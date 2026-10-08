import { browse } from './browse';
import {
  emptyStats,
  RunError,
  stopRequestOf,
  toFailure,
  type RunEvent,
  type RunFailure,
  type RunOutcome,
  type RunResult,
  type RunState,
  type RunStats,
  type StopCause,
  type StopRequest,
} from './events';
import type { LevelSnapshot, MetricKey } from './metrics';
import { mergeDiscoveredCategories } from './plan';
import type { AuthMode, AuthResult, AuthSession, ForumPort, RunCoordinator } from './ports';
import { isAbortError, seededRandom, throwIfAborted, type RuntimeDeps } from './runtime';
import type { BrowserMode, Category, Profile, ProfileHealth, ProfileId, RunPlanSnapshot, Site, SiteId } from './terms';

export interface ForumSession {
  forum: ForumPort;
  /** Aborts with `stopRequest('browser-closed')` once the browser goes away from outside. */
  closed: AbortSignal;
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
/** S07: connect's statistics trail a run by about 3 minutes (Phase 1); the final read is retried once after this. */
export const SITE_LAG_WAIT_MS = 240_000;
const INSPECT_TIMEOUT_MS = 60_000;

/** What ended a step early: a stop request on its signal, or a failure. */
type Interruption = { kind: 'stop'; cause: StopRequest } | { kind: 'failure'; failure: RunFailure };

/** The one place an error becomes a stop or a failure: whatever is thrown after `signal` aborted is the stop's echo. */
function classify(err: unknown, signal: AbortSignal): Interruption {
  if (signal.aborted || isAbortError(err)) return { kind: 'stop', cause: stopRequestOf(signal) };
  return { kind: 'failure', failure: toFailure(err) };
}

/** One sign-in check that never waits for a person: credentials on password sites, otherwise a look at the page. */
function checkMode(site: Site, browserMode: BrowserMode): AuthMode {
  return site.login === 'password' && browserMode === 'headless' ? 'credentials' : 'headless-check';
}

/** S09: a site with a progress page either read its baseline before browsing or runs without one. */
function baselineOf(site: Site | null, initial: LevelSnapshot | null): RunResult['baseline'] {
  if (!site || site.progressSource === 'none') return 'not-applicable';
  return initial ? 'present' : 'missing';
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

/**
 * S08: how many confirmed topics the progress page's `topicsViewed` change does not show yet; null
 * when there is no change to compare (no baseline, or no such metric) or nothing is missing.
 */
export function reportedTopicsShortfall(stats: Pick<RunStats, 'confirmed' | 'reported'>): number | null {
  const viewed = stats.reported?.topicsViewed;
  if (viewed?.initial === undefined) return null;
  const missing = stats.confirmed.topics - (viewed.final - viewed.initial);
  return missing > 0 ? missing : null;
}

/** §6.1 / §6.2: the one kernel every entry point (CLI, server, scheduler) runs. */
export class DiscoLurkCoordinator implements RunCoordinator {
  constructor(private readonly env: CoordinatorEnv) {}

  async run(plan: RunPlanSnapshot, signal: AbortSignal, emit: (e: RunEvent) => void): Promise<RunResult> {
    // §9.1: the snapshot's seed fixes this run's choices, so the same snapshot replays the same picks.
    const deps: RuntimeDeps = { ...this.env.deps, random: seededRandom(plan.seed) };
    const at = () => new Date(deps.clock.now()).toISOString();
    let current: RunState = 'queued';
    const state = (s: RunState) => {
      current = s;
      emit({ type: 'state', at: at(), state: s });
    };
    const warn = (code: string, message: string) => emit({ type: 'warning', at: at(), code, message });
    let site: Site | null = null;
    let stats: RunStats = emptyStats();
    const levels: RunResult['levels'] = { initial: null, final: null };

    const end = (outcome: RunOutcome, stopCause: StopCause, failure?: RunFailure): RunResult => {
      if (failure) emit({ type: 'error', at: at(), error: failure });
      state(outcome);
      return { outcome, stopCause, stats, baseline: baselineOf(site, levels.initial), levels, ...(failure ? { failure } : {}) };
    };

    state('queued');
    state('launching');
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
    const runSite: Site = site;
    // A browser closed from outside reaches every step as one more stop request.
    const live = AbortSignal.any([signal, session.closed]);

    const verify = async (stopCause: StopCause, failure?: RunFailure): Promise<RunResult> => {
      state('verifying');
      if (runSite.progressSource !== 'none') {
        const cancelSignals = [session.closed, ...(this.env.exitSignal ? [this.env.exitSignal] : [])];
        const readFinal = async () => {
          levels.final = await forum.readProgress('final', AbortSignal.any([AbortSignal.timeout(VERIFY_TIMEOUT_MS), ...cancelSignals]));
          if (levels.final) stats.reported = reportedMetrics(levels.initial, levels.final);
        };
        try {
          await readFinal();
          if (runSite.progressSource === 'connect-linuxdo' && reportedTopicsShortfall(stats) !== null) {
            await this.awaitSiteLag(stats, deps, AbortSignal.any(cancelSignals), signal, readFinal, warn);
          }
        } catch (err) {
          if (this.env.exitSignal?.aborted) return end('cancelled', 'app-exit', failure);
          if (session.closed.aborted) return end('cancelled', 'browser-closed', failure);
          const f = toFailure(err);
          if (failure) warn('final-progress-failed', `${f.code}: ${f.message}`);
          else failure = isAbortError(err) ? { code: 'page-timeout', message: 'Final progress read timed out' } : f;
        }
      }
      emit({ type: 'stats', at: at(), stats: structuredClone(stats) });
      return end(failure ? 'failed' : 'completed', stopCause, failure);
    };

    /**
     * §6.2: where an interrupted phase goes. Every stop passes through `stopping`; only browsing has
     * progress worth verifying, and only a user stop or a failure leaves a browser to verify with.
     */
    const interrupt = (from: RunState, why: Interruption): RunResult | Promise<RunResult> => {
      if (why.kind === 'failure' && from !== 'browsing') return end('failed', 'error', why.failure);
      state('stopping');
      if (why.kind === 'failure') return verify('error', why.failure);
      if (from === 'browsing' && why.cause === 'user') return verify('user');
      return end('cancelled', why.cause);
    };

    try {
      throwIfAborted(live);
      let auth = await forum.ensureAuthenticated(checkMode(runSite, plan.browserMode), live);
      if (auth.status !== 'authenticated') {
        state('awaiting_login');
        // B04/B05: only a headed window has a person who can finish signing in.
        if (plan.browserMode === 'headed') auth = await forum.ensureAuthenticated('headed-wait', live);
        if (auth.status === 'challenge-detected') {
          state('challenge_detected');
          return end('failed', 'error', { code: 'challenge-detected', message: 'The site shows a challenge page; it is reported, never solved' });
        }
        if (auth.status === 'needs-auth') {
          state('needs_auth');
          return end('cancelled', 'error', { code: 'needs-auth', message: `Not signed in to ${runSite.displayName}; run \`lurk login --site ${runSite.id}\`` });
        }
      }

      state('reading_initial_progress');
      if (runSite.progressSource !== 'none') {
        try {
          levels.initial = await forum.readProgress('initial', live);
        } catch (err) {
          const why = classify(err, live);
          if (why.kind === 'stop') throw err;
          warn('baseline-missing', `Initial progress read failed (${why.failure.code}: ${why.failure.message}); continuing without a baseline`);
        }
      }
      if (runSite.categorySource === 'discovered') await this.refreshCategories(runSite, forum, live, warn);

      state('browsing');
      const out = await browse({ plan, forum, deps, signal: live, emit });
      stats = out.stats;
      switch (out.end) {
        case 'target-reached':
          return await verify('target');
        case 'no-progress':
          state('no_progress');
          return await verify('no-progress', { code: 'no-progress', message: 'A whole round entered no topic' });
        case 'cancelled':
          return await interrupt('browsing', { kind: 'stop', cause: stopRequestOf(live) });
        case 'error':
          return await interrupt('browsing', { kind: 'failure', failure: out.failure });
      }
    } catch (err) {
      return await interrupt(current, classify(err, live));
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
      let auth: AuthResult;
      try {
        auth = await session.forum.ensureAuthenticated(checkMode(site, 'headless'), signal);
      } catch (err) {
        if (err instanceof RunError) return { profileId, status: 'broken', checkedAt: checkedAt() };
        throw err;
      }
      if (auth.status !== 'authenticated') return { profileId, status: 'needs-auth', checkedAt: checkedAt() };
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
      recheck: () => session.forum.ensureAuthenticated('headless-check', AbortSignal.any([AbortSignal.timeout(INSPECT_TIMEOUT_MS), session.closed])),
      continueWaiting: (signal) => session.forum.ensureAuthenticated('headed-wait', AbortSignal.any([signal, session.closed])),
      close: () => session.close(),
    };
  }

  /**
   * S07: the browser stays open while connect catches up, then the final read runs once more and
   * its numbers replace the first ones. A user stop during the wait keeps the first read; a closed
   * browser or the app exiting throws, so the caller cancels the run as for any final read.
   */
  private async awaitSiteLag(
    stats: RunStats,
    deps: RuntimeDeps,
    cancel: AbortSignal,
    userSignal: AbortSignal,
    readFinal: () => Promise<void>,
    warn: (code: string, message: string) => void,
  ): Promise<void> {
    const missing = () => `${reportedTopicsShortfall(stats) ?? 0} of ${stats.confirmed.topics} confirmed topics`;
    warn('site-lag', `Site statistics are missing ${missing()}; reading again in ${SITE_LAG_WAIT_MS / 60_000} minutes`);
    // A run already stopped by the user still waits; only a second request (the exit signal) cuts it short.
    const waitSignal = userSignal.aborted ? cancel : AbortSignal.any([cancel, userSignal]);
    try {
      await deps.sleeper.sleep(SITE_LAG_WAIT_MS, waitSignal);
    } catch (err) {
      if (cancel.aborted || !isAbortError(err)) throw err;
      warn('site-lag', 'Stopped while waiting; keeping the first final read');
      return;
    }
    try {
      await readFinal();
    } catch (err) {
      if (cancel.aborted) throw err;
      const f = toFailure(err);
      warn('final-progress-failed', `Re-read failed (${f.code}: ${f.message}); keeping the first final read`);
      return;
    }
    if (reportedTopicsShortfall(stats) !== null) warn('site-lag', `Site statistics are still missing ${missing()} after the re-read`);
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
      const merged = mergeDiscoveredCategories(known, found);
      if (JSON.stringify(merged) !== JSON.stringify(known)) await this.env.categories.save(site.id, merged);
    } catch (err) {
      const why = classify(err, signal);
      if (why.kind === 'stop') throw err;
      warn('category-discovery-failed', `${why.failure.code}: ${why.failure.message}`);
    }
  }
}
