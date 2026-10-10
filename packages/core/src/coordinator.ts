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
import type { LedgerStore, VisitLedger } from './ledger';
import { mergeDiscoveredCategories } from './plan';
import { TimingsTally, toTenthsSeconds, type TimingsReceipt } from './timings';
import type { AuthMode, AuthSession, ForumPort, RunCoordinator } from './ports';
import { isAbortError, seededRandom, throwIfAborted, type RuntimeDeps } from './runtime';
import type { BrowserMode, Category, Profile, ProfileHealth, ProfileId, RunPlanSnapshot, Site, SiteId } from './terms';

export interface ForumSession {
  forum: ForumPort;
  /** Aborts with `stopRequest('browser-closed')` once the browser goes away from outside. */
  closed: AbortSignal;
  /** Closes the browser and releases the Profile lock. */
  close(): Promise<void>;
}

interface OpenRequest {
  site: Site;
  profile: Profile;
  browserMode: BrowserMode;
  runId: string;
  /** Adapter-side observations that belong in the run's event stream. */
  warn(code: string, message: string): void;
  /** Each `/topics/timings` flush the site acknowledged. */
  timings(receipt: TimingsReceipt): void;
}

/** Where a discovered site's category list is kept between runs. */
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
  /** Where each Profile's visit ledger is kept; without one, visits are not remembered. */
  ledgers?: LedgerStore;
  /**
   * Aborts when the application exits. A user stop still verifies against the progress page;
   * this signal also cuts that verification short.
   */
  exitSignal?: AbortSignal;
}

const TIMEOUTS = {
  /** The progress page itself gets 10 s; the rest covers navigation and the forced reload. */
  verifyMs: 60_000,
  /** Connect's statistics trail a run by about 3 minutes; the final read is retried once after this. */
  siteLagMs: 240_000,
  inspectMs: 60_000,
} as const;

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

/** A site with a progress page either read its baseline before browsing or runs without one. */
function baselineOf(site: Site | null, initial: LevelSnapshot | null): RunResult['baseline'] {
  if (!site || site.progressSource === 'none') return 'not-applicable';
  return initial ? 'present' : 'missing';
}

/**
 * The progress page's own numbers per metric key. `other` gathers several unrelated labels,
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
 * How many confirmed topics the progress page's `topicsViewed` change does not show yet; null
 * when there is no change to compare (no baseline, or no such metric) or nothing is missing.
 */
export function reportedTopicsShortfall(stats: Pick<RunStats, 'confirmed' | 'reported'>): number | null {
  const viewed = stats.reported?.topicsViewed;
  if (viewed?.initial === undefined) return null;
  const missing = stats.confirmed.topics - (viewed.final - viewed.initial);
  return missing > 0 ? missing : null;
}

/** The one kernel every entry point (CLI, server, scheduler) runs. */
export class DiscoLurkCoordinator implements RunCoordinator {
  constructor(private readonly env: CoordinatorEnv) {}

  async run(plan: RunPlanSnapshot, signal: AbortSignal, emit: (e: RunEvent) => void, skipWait?: AbortSignal): Promise<RunResult> {
    // The snapshot's seed fixes this run's choices, so the same snapshot replays the same picks.
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
    const tally = new TimingsTally();
    // Asserted rather than annotated: it is assigned inside `body`, so narrowing to the initial null must not stick.
    let ledger = null as VisitLedger | null;
    const onTimings = (receipt: TimingsReceipt) => {
      tally.add(receipt);
      emit({ type: 'timings', at: at(), postsReported: receipt.postNumbers.length, topicSeconds: toTenthsSeconds(receipt.topicMs) });
    };

    // Every ending carries the receipts acknowledged up to that point, whichever path reached it.
    const end = (outcome: RunOutcome, stopCause: StopCause, failure?: RunFailure): RunResult => {
      stats.timings = tally.snapshot();
      return { outcome, stopCause, stats, baseline: baselineOf(site, levels.initial), levels, ...(failure ? { failure } : {}) };
    };
    // The terminal state is announced only once the browser is closed and the Profile lock released,
    // so whoever sees `completed` may start the next run on the same Profile at once.
    const finish = (result: RunResult): RunResult => {
      if (result.failure) emit({ type: 'error', at: at(), error: result.failure });
      state(result.outcome);
      return result;
    };

    state('queued');
    state('launching');
    let session: ForumSession;
    try {
      const resolved = await this.env.resolveProfile(plan.profileId);
      site = resolved.site;
      if (site.id !== plan.siteId) throw new RunError('internal', `Profile ${plan.profileId} belongs to ${site.id}, not ${plan.siteId}`);
      if (plan.preset.categories.length === 0) throw new RunError('no-candidates', 'No category is enabled for this run');
      session = await this.env.open({ site, profile: resolved.profile, browserMode: plan.browserMode, runId: plan.id, warn, timings: onTimings });
    } catch (err) {
      return finish(end('failed', 'error', toFailure(err)));
    }
    const { forum } = session;
    const runSite: Site = site;
    // A browser closed from outside reaches every step as one more stop request.
    const live = AbortSignal.any([signal, session.closed]);

    /**
     * The end-of-run progress read reports on the run; it does not decide it. A failed read is a
     * warning and leaves `levels.final` empty, and the outcome stays what browsing made it. Only the
     * browser closing or the app exiting during the read cancels the run.
     */
    const verify = async (stopCause: StopCause, failure?: RunFailure): Promise<RunResult> => {
      state('verifying');
      if (runSite.progressSource !== 'none') {
        const exitSignals = this.env.exitSignal ? [this.env.exitSignal] : [];
        const readFinal = async () => {
          const snapshot = await forum.readProgress('final', AbortSignal.any([AbortSignal.timeout(TIMEOUTS.verifyMs), session.closed, ...exitSignals]));
          levels.final = snapshot;
          if (snapshot) {
            stats.reported = reportedMetrics(levels.initial, snapshot);
            emit({ type: 'levels', at: at(), kind: 'final', snapshot });
          }
        };
        try {
          await readFinal();
        } catch (err) {
          if (this.env.exitSignal?.aborted) return end('cancelled', 'app-exit', failure);
          if (session.closed.aborted) return end('cancelled', 'browser-closed', failure);
          const f = isAbortError(err) ? { code: 'page-timeout', message: 'Final progress read timed out' } : toFailure(err);
          warn('final-progress-failed', `${f.code}: ${f.message}`);
        }
        if (levels.final && runSite.progressSource === 'connect-linuxdo' && reportedTopicsShortfall(stats) !== null) {
          const exited = await this.awaitSiteLag(stats, deps, { exit: this.env.exitSignal, closed: session.closed, user: signal, skip: skipWait }, readFinal, warn);
          if (exited) return end('cancelled', 'app-exit', failure);
        }
      }
      stats.timings = tally.snapshot();
      emit({ type: 'stats', at: at(), stats: structuredClone(stats) });
      return end(failure ? 'failed' : 'completed', stopCause, failure);
    };

    /**
     * Where an interrupted phase goes. Every stop passes through `stopping`; only browsing has
     * progress worth verifying, and only a user stop or a failure leaves a browser to verify with.
     */
    const interrupt = (from: RunState, why: Interruption): RunResult | Promise<RunResult> => {
      if (why.kind === 'failure' && from !== 'browsing') return end('failed', 'error', why.failure);
      state('stopping');
      if (why.kind === 'failure') return verify('error', why.failure);
      if (from === 'browsing' && why.cause === 'user') return verify('user');
      return end('cancelled', why.cause);
    };

    const body = async (): Promise<RunResult> => {
      try {
        throwIfAborted(live);
        let auth = await forum.ensureAuthenticated(checkMode(runSite, plan.browserMode), live);
        if (auth.status !== 'authenticated') {
          state('awaiting_login');
          // Only a headed window has a person who can finish signing in.
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

        try {
          const username = await forum.readUsername(live);
          if (username) emit({ type: 'signed-in', at: at(), username });
        } catch (err) {
          const why = classify(err, live);
          if (why.kind === 'stop') throw err;
          warn('username-missing', `Reading the username failed (${why.failure.code}: ${why.failure.message}); continuing`);
        }

        state('reading_initial_progress');
        if (runSite.progressSource !== 'none') {
          try {
            levels.initial = await forum.readProgress('initial', live);
            if (levels.initial) emit({ type: 'levels', at: at(), kind: 'initial', snapshot: levels.initial });
          } catch (err) {
            const why = classify(err, live);
            if (why.kind === 'stop') throw err;
            // A progress page that wants an authorization the run cannot get ends it as a sign-in would.
            if (why.failure.code === 'needs-auth') {
              state('needs_auth');
              return end('cancelled', 'error', why.failure);
            }
            warn('baseline-missing', `Initial progress read failed (${why.failure.code}: ${why.failure.message}); continuing without a baseline`);
          }
        }
        if (runSite.categorySource === 'discovered') await this.refreshCategories(runSite, forum, live, warn);
        const categories =
          runSite.categorySource === 'builtin' && plan.preset.experiments.refreshCategories
            ? await this.refreshBuiltinPaths(plan.preset.categories, forum, live, warn)
            : plan.preset.categories;
        ledger = await this.openLedger(plan.profileId, warn);

        state('browsing');
        const out = await browse({ plan, forum, deps, signal: live, emit, categories, timings: tally, ...(ledger ? { ledger } : {}) });
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
      }
    };

    let result: RunResult;
    try {
      result = await body();
    } finally {
      await session.close();
    }
    if (ledger) {
      try {
        await ledger.save();
      } catch (err) {
        warn('ledger-save-failed', toFailure(err).message);
      }
    }
    return finish(result);
  }

  async inspect(profileId: ProfileId): Promise<ProfileHealth> {
    const { profile, site } = await this.env.resolveProfile(profileId);
    let session: ForumSession;
    try {
      session = await this.env.open({ site, profile, browserMode: 'headless', runId: `inspect-${this.env.deps.clock.now()}`, warn: () => {}, timings: () => {} });
    } catch (err) {
      const locked = err instanceof RunError && err.code === 'profile-locked';
      return { profileId, status: locked ? 'locked' : 'broken', checkedAt: this.checkedAt() };
    }
    try {
      return await this.healthOf(profileId, site, session, checkMode(site, 'headless'));
    } finally {
      await session.close();
    }
  }

  private checkedAt(): string {
    return new Date(this.env.deps.clock.now()).toISOString();
  }

  /** The health of a Profile whose browser is already open; the session stays open. */
  private async healthOf(profileId: ProfileId, site: Site, session: ForumSession, mode: AuthMode): Promise<ProfileHealth> {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUTS.inspectMs), session.closed]);
    try {
      const auth = await session.forum.ensureAuthenticated(mode, signal);
      if (auth.status !== 'authenticated') return { profileId, status: 'needs-auth', checkedAt: this.checkedAt() };
      const username = await session.forum.readUsername(signal);
      // The health check is where a discovered site reads its categories.
      if (site.categorySource === 'discovered') await this.refreshCategories(site, session.forum, signal, () => {});
      return { profileId, status: 'ready', ...(username ? { username } : {}), checkedAt: this.checkedAt() };
    } catch (err) {
      // A check that ran out of time, lost its browser or met a page failure cannot vouch for the Profile.
      if (err instanceof RunError || signal.aborted || isAbortError(err)) return { profileId, status: 'broken', checkedAt: this.checkedAt() };
      throw err;
    }
  }

  async beginAuth(profileId: ProfileId): Promise<AuthSession> {
    const { profile, site } = await this.env.resolveProfile(profileId);
    const session = await this.env.open({ site, profile, browserMode: 'headed', runId: `auth-${this.env.deps.clock.now()}`, warn: () => {}, timings: () => {} });
    return {
      recheck: () => session.forum.ensureAuthenticated('headless-check', AbortSignal.any([AbortSignal.timeout(TIMEOUTS.inspectMs), session.closed])),
      continueWaiting: (signal) => session.forum.ensureAuthenticated('headed-wait', AbortSignal.any([signal, session.closed])),
      inspect: () => this.healthOf(profileId, site, session, 'headless-check'),
      close: () => session.close(),
    };
  }

  /**
   * The browser stays open while connect catches up, then the final read runs once more and
   * its numbers replace the first ones. A user stop or a closed browser during the wait keeps the
   * first read, as does the skip request a person sends after stopping; only the app exiting
   * cancels the run, which the `true` result reports.
   */
  private async awaitSiteLag(
    stats: RunStats,
    deps: RuntimeDeps,
    signals: { exit: AbortSignal | undefined; closed: AbortSignal; user: AbortSignal; skip: AbortSignal | undefined },
    readFinal: () => Promise<void>,
    warn: (code: string, message: string) => void,
  ): Promise<boolean> {
    const exited = () => signals.exit?.aborted === true;
    const missing = () => `${reportedTopicsShortfall(stats) ?? 0} of ${stats.confirmed.topics} confirmed topics`;
    warn('site-lag', `Site statistics are missing ${missing()}; reading again in ${TIMEOUTS.siteLagMs / 60_000} minutes`);
    // A run already stopped by the user still waits; only a second request (skip or exit) cuts it short.
    const waitSignal = AbortSignal.any([
      signals.closed,
      ...(signals.exit ? [signals.exit] : []),
      ...(signals.skip ? [signals.skip] : []),
      ...(signals.user.aborted ? [] : [signals.user]),
    ]);
    try {
      await deps.sleeper.sleep(TIMEOUTS.siteLagMs, waitSignal);
    } catch (err) {
      if (!isAbortError(err)) throw err;
      if (exited()) return true;
      warn('site-lag', 'Stopped while waiting; keeping the first final read');
      return false;
    }
    try {
      await readFinal();
    } catch (err) {
      if (exited()) return true;
      const f = toFailure(err);
      warn('final-progress-failed', `Re-read failed (${f.code}: ${f.message}); keeping the first final read`);
      return false;
    }
    if (reportedTopicsShortfall(stats) !== null) warn('site-lag', `Site statistics are still missing ${missing()} after the re-read`);
    return false;
  }

  private async openLedger(profileId: ProfileId, warn: (code: string, message: string) => void): Promise<VisitLedger | null> {
    if (!this.env.ledgers) return null;
    try {
      return await this.env.ledgers.open(profileId);
    } catch (err) {
      warn('ledger-unavailable', `${toFailure(err).message}; this run's visits are not remembered`);
      return null;
    }
  }

  /**
   * A builtin site's table is checked against the categories page before browsing. Only a
   * category whose id the page also lists is trusted to have moved, and only its path changes:
   * nothing is added and no enable choice changes. A failed read keeps the table as it is.
   */
  private async refreshBuiltinPaths(planned: readonly Category[], forum: ForumPort, signal: AbortSignal, warn: (code: string, message: string) => void): Promise<Category[]> {
    let found: Category[];
    try {
      found = await forum.discoverCategories(signal);
    } catch (err) {
      const why = classify(err, signal);
      if (why.kind === 'stop') throw err;
      warn('category-discovery-failed', `${why.failure.code}: ${why.failure.message}`);
      return [...planned];
    }
    return planned.map((c) => {
      const live = found.find((f) => f.id === c.id);
      if (!live || live.path === c.path) return c;
      warn('category-path-updated', `${c.name} moved from ${c.path} to ${live.path}`);
      return { ...c, path: live.path };
    });
  }

  /** A discovered site re-reads its categories after every sign-in; a failed read keeps the stored list. */
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
