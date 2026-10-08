import { describe, expect, it } from 'vitest';
import { DiscoLurkCoordinator, reportedMetrics, type CategoryStore, type CoordinatorEnv } from './coordinator';
import { RunError, stopRequest, type RunEvent, type RunState } from './events';
import type { LevelSnapshot } from './metrics';
import type { AuthMode, AuthResult } from './ports';
import { FixtureForum, fixtureSite, VirtualTime, type FixtureForumOptions } from './testing';
import type { BrowserMode, Category, RunMode, RunPlanSnapshot, Site, TopicCandidate } from './terms';

const site = (over: Partial<Site> = {}): Site =>
  fixtureSite({
    categorySource: 'builtin',
    builtinCategories: [],
    progressSource: 'trust-level-docofcard',
    progressUrl: 'https://forum.invalid/my/trust-level',
    ...over,
  });

const categories: Category[] = ['a', 'b'].map((slug, i) => ({ name: slug, path: `/c/${slug}/${i + 1}`, id: i + 1, enabledByDefault: true }));

function plan(runMode: RunMode, browserMode: BrowserMode = 'headless', cats = categories): RunPlanSnapshot {
  return {
    id: 'run-1',
    siteId: 'fixture',
    profileId: 'fixture/main',
    browserMode,
    seed: 11,
    plannedAt: '2026-10-08T00:00:00.000Z',
    materializedAt: '2026-10-08T00:00:00.000Z',
    preset: {
      presetId: 'p',
      browseMode: 'quick',
      runMode,
      categories: cats,
      interaction: {
        like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
        reply: { enabled: false, rate: 5 },
      },
      extraWait: { enabled: true, minSec: 1, maxSec: 3 },
      samplePerCategory: { min: 3, max: 8 },
    },
  };
}

const unread = (path: string, call: number): TopicCandidate[] =>
  Array.from({ length: 4 }, (_, i) => ({ id: `${path}#${call}#${i}`, title: 't', unread: true, pinned: false }));

const level = (topics: number, posts: number): LevelSnapshot => ({
  source: 'trust-level-docofcard',
  level: '初窥命运之人',
  metrics: [
    { label: '进入过的主题', key: 'topicsViewed', current: topics, required: 5 },
    { label: '已读帖子', key: 'postsRead', current: posts, required: 30 },
    { label: '注册时长（分钟）', key: 'other', current: 30611, required: 30 },
  ],
});

class MemoryCategories implements CategoryStore {
  saved = new Map<string, Category[]>();
  async load(siteId: string) {
    return structuredClone(this.saved.get(siteId) ?? []);
  }
  async save(siteId: string, list: Category[]) {
    this.saved.set(siteId, structuredClone(list));
  }
}

interface Setup {
  site?: Site;
  /** A headed sign-in that completes at this virtual instant. */
  signInAt?: number;
  forum?: Partial<Omit<FixtureForumOptions, 'site' | 'sleeper'>>;
  open?: () => never;
  exit?: AbortController;
}

function setup(opts: Setup = {}) {
  const time = new VirtualTime();
  const s = opts.site ?? site();
  const forum = new FixtureForum({
    site: s,
    sleeper: time.sleeper,
    topics: unread,
    ...(opts.signInAt !== undefined ? { auth: loginAfter(time, opts.signInAt) } : {}),
    ...opts.forum,
  });
  const categoryStore = new MemoryCategories();
  const browser = new AbortController();
  let closed = 0;
  const events: RunEvent[] = [];
  /** How many events had been emitted when the session closed. */
  let eventsAtClose = -1;
  const env: CoordinatorEnv = {
    deps: time.deps(1),
    resolveProfile: async (profileId) => ({ profile: { id: profileId, siteId: s.id, channel: 'chrome' }, site: s }),
    open: async () => {
      if (opts.open) opts.open();
      return {
        forum,
        closed: browser.signal,
        close: async () => {
          closed++;
          eventsAtClose = events.length;
        },
      };
    },
    categories: categoryStore,
    ...(opts.exit ? { exitSignal: opts.exit.signal } : {}),
  };
  const coordinator = new DiscoLurkCoordinator(env);
  const controller = new AbortController();
  const run = (p: RunPlanSnapshot) => time.drive(coordinator.run(p, controller.signal, (e) => events.push(e)));
  const states = () => events.filter((e) => e.type === 'state').map((e) => (e as { state: RunState }).state);
  return { time, forum, coordinator, events, controller, browser, run, states, categoryStore, closed: () => closed, eventsAtClose: () => eventsAtClose };
}

/** A headed login that only succeeds once the virtual clock passes `atMs`; it polls like B04. */
function loginAfter(time: VirtualTime, atMs: number) {
  return async (mode: AuthMode, signal: AbortSignal): Promise<AuthResult> => {
    if (mode !== 'headed-wait') return { status: 'needs-auth' };
    while (time.clock.monotonic() < atMs) await time.sleeper.sleep(5_000, signal);
    return { status: 'authenticated' };
  };
}

describe('STATE-001 run state machine (§6.2)', () => {
  it('walks queued → … → completed for a run that meets its target', async () => {
    const { run, states, closed } = setup({ forum: { progress: async (k) => level(k === 'initial' ? 21 : 24, 175) } });
    const out = await run(plan({ kind: 'topics', count: 3 }));
    expect(states()).toEqual(['queued', 'launching', 'reading_initial_progress', 'browsing', 'verifying', 'completed']);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target', baseline: 'present' });
    expect(closed()).toBe(1);
  });

  it('goes awaiting_login → reading_initial_progress once the headed user signs in', async () => {
    const t = setup({ signInAt: 30_000 });
    const out = await t.run(plan({ kind: 'topics', count: 2 }, 'headed'));
    expect(t.states().slice(0, 4)).toEqual(['queued', 'launching', 'awaiting_login', 'reading_initial_progress']);
    expect(out.outcome).toBe('completed');
  });

  it('awaiting_login → stopping → cancelled when the user stops while waiting for sign-in', async () => {
    const t = setup({ signInAt: 300_000 });
    t.time.at(20_000, () => t.controller.abort(stopRequest('user')));
    const out = await t.run(plan({ kind: 'endless' }, 'headed'));
    expect(t.states()).toEqual(['queued', 'launching', 'awaiting_login', 'stopping', 'cancelled']);
    expect(out).toMatchObject({ outcome: 'cancelled', stopCause: 'user' });
    expect(t.forum.calls.some((c) => c.op === 'collectTopics')).toBe(false);
    expect(t.closed()).toBe(1);
  });

  it('awaiting_login → cancelled with stop cause app-exit when the application quits', async () => {
    const t = setup({ signInAt: 300_000 });
    t.time.at(20_000, () => t.controller.abort(stopRequest('app-exit')));
    const out = await t.run(plan({ kind: 'endless' }, 'headed'));
    expect(t.states().at(-1)).toBe('cancelled');
    expect(out.stopCause).toBe('app-exit');
  });

  it('a headless run without a session goes awaiting_login → needs_auth → cancelled (needs-auth)', async () => {
    const { run, states } = setup({ forum: { auth: async () => ({ status: 'needs-auth' }) } });
    const out = await run(plan({ kind: 'endless' }));
    expect(states()).toEqual(['queued', 'launching', 'awaiting_login', 'needs_auth', 'cancelled']);
    expect(out.failure?.code).toBe('needs-auth');
  });

  it('a challenge page goes awaiting_login → challenge_detected → failed and is never handled', async () => {
    const { run, states, forum } = setup({ forum: { auth: async () => ({ status: 'challenge-detected' }) } });
    const out = await run(plan({ kind: 'endless' }));
    expect(states()).toEqual(['queued', 'launching', 'awaiting_login', 'challenge_detected', 'failed']);
    expect(out.failure?.code).toBe('challenge-detected');
    expect(forum.calls.map((c) => c.op)).toEqual(['ensureAuthenticated']);
  });

  it('launching → failed when the Profile is locked or the browser is missing', async () => {
    const { run, states } = setup({
      open: () => {
        throw new RunError('profile-locked', 'held by PID 1');
      },
    });
    const out = await run(plan({ kind: 'endless' }));
    expect(states()).toEqual(['queued', 'launching', 'failed']);
    expect(out.failure?.code).toBe('profile-locked');
  });

  it('a user stop while browsing goes stopping → verifying → completed and still reads the progress page', async () => {
    const t = setup({ forum: { progress: async (k) => level(k === 'initial' ? 21 : 22, 175) } });
    t.time.at(40_000, () => t.controller.abort(stopRequest('user')));
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-4)).toEqual(['browsing', 'stopping', 'verifying', 'completed']);
    expect(out.stopCause).toBe('user');
    expect(t.forum.calls.filter((c) => c.op === 'readProgress').map((c) => (c as { kind: string }).kind)).toEqual(['initial', 'final']);
    expect(out.levels.final).not.toBeNull();
  });

  it('app-exit while browsing goes stopping → cancelled without a final read', async () => {
    const exit = new AbortController();
    const t = setup({ exit, forum: { progress: async () => level(21, 175) } });
    t.time.at(40_000, () => {
      t.controller.abort(stopRequest('app-exit'));
      exit.abort();
    });
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-3)).toEqual(['browsing', 'stopping', 'cancelled']);
    expect(out.stopCause).toBe('app-exit');
    expect(t.forum.calls.filter((c) => c.op === 'readProgress')).toHaveLength(1);
  });

  it('an error while browsing goes stopping → verifying → failed and keeps the stats so far', async () => {
    let collects = 0;
    const t = setup({
      forum: {
        topics: (path, call) => {
          if (++collects > 1) throw new RunError('needs-auth', 'signed out');
          return unread(path, call);
        },
      },
    });
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-4)).toEqual(['browsing', 'stopping', 'verifying', 'failed']);
    expect(out.failure?.code).toBe('needs-auth');
    expect(out.stats.confirmed.topics).toBeGreaterThan(0);
  });

  it('a run without categories fails with no-candidates before any browser starts', async () => {
    const { run, states } = setup({
      open: () => {
        throw new Error('must not launch');
      },
    });
    const out = await run(plan({ kind: 'endless' }, 'headless', []));
    expect(states()).toEqual(['queued', 'launching', 'failed']);
    expect(out.failure?.code).toBe('no-candidates');
  });
});

describe('RUN-002 / S06 no-progress through the coordinator', () => {
  it('goes browsing → no_progress → verifying → failed (no-progress)', async () => {
    const { run, states, events } = setup({ forum: { topics: () => [] } });
    const out = await run(plan({ kind: 'topics', count: 5 }));
    expect(states().slice(-4)).toEqual(['browsing', 'no_progress', 'verifying', 'failed']);
    expect(out).toMatchObject({ stopCause: 'no-progress', failure: { code: 'no-progress' } });
    // Every category rendered no rows, so each was skipped as empty rather than reported as a broken contract.
    const empties = events.filter((e) => e.type === 'warning' && e.code === 'empty-category');
    expect(empties).toHaveLength(categories.length);
  });
});

describe('empty-category (§7.1 step 2)', () => {
  it('skips an empty category with a warning and keeps browsing the others', async () => {
    const { run, events } = setup({ forum: { topics: (path, call) => (path === '/c/a/1' ? [] : unread(path, call)) } });
    const out = await run(plan({ kind: 'topics', count: 3 }));
    expect(out.outcome).toBe('completed');
    expect(events.some((e) => e.type === 'warning' && e.code === 'empty-category' && e.message.includes('/c/a/1'))).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('PROGRESS-001 final report from the site (S07, S08)', () => {
  it('keeps attempted / confirmed and adds reported values from the forced final read', async () => {
    const { run } = setup({ forum: { progress: async (k) => level(k === 'initial' ? 21 : 24, k === 'initial' ? 175 : 190) } });
    const out = await run(plan({ kind: 'topics', count: 3 }));
    expect(out.stats.attempted.topics).toBeGreaterThanOrEqual(3);
    expect(out.stats.confirmed.topics).toBe(3);
    expect(out.stats.reported).toEqual({ topicsViewed: { initial: 21, final: 24 }, postsRead: { initial: 175, final: 190 } });
  });

  it('reports only attempted / confirmed for a site without a progress page', async () => {
    const { run, forum } = setup({ site: site({ progressSource: 'none' }) });
    const out = await run(plan({ kind: 'topics', count: 2 }));
    expect(out.baseline).toBe('not-applicable');
    expect(out.stats.reported).toBeUndefined();
    expect(forum.calls.some((c) => c.op === 'readProgress')).toBe(false);
  });

  it('labels without an estimate stay out of the per-key report', () => {
    expect(reportedMetrics(null, level(3, 4))).toEqual({ topicsViewed: { final: 3 }, postsRead: { final: 4 } });
  });
});

describe('PROGRESS-002 initial read failure (S09)', () => {
  it('runs without a baseline, warns, and reports final values only', async () => {
    const { run, events, states } = setup({
      forum: {
        progress: async (kind) => {
          if (kind === 'initial') throw new RunError('page-timeout', 'no table rows within 10 s');
          return level(24, 190);
        },
      },
    });
    const out = await run(plan({ kind: 'topics', count: 2 }));
    expect(states()).toContain('browsing');
    expect(out).toMatchObject({ outcome: 'completed', baseline: 'missing' });
    expect(out.levels.initial).toBeNull();
    expect(out.stats.reported).toEqual({ topicsViewed: { final: 24 }, postsRead: { final: 190 } });
    expect(events.some((e) => e.type === 'warning' && e.code === 'baseline-missing')).toBe(true);
  });
});

describe('CAT-001 discovered categories (§7.1 step 2, §7.2)', () => {
  const found: Category[] = [
    { name: '卡片交流', path: '/c/bank/6', id: 6, enabledByDefault: false },
    { name: 'General', path: '/c/general/4', id: 4, enabledByDefault: false },
  ];

  it('re-reads categories after sign-in and stores new ones disabled, keeping earlier choices', async () => {
    const discovered = site({ id: 'fixture', categorySource: 'discovered' });
    delete discovered.builtinCategories;
    const t = setup({ site: discovered, forum: { discovered: found } });
    await t.categoryStore.save('fixture', [{ name: 'General', path: '/c/general/4', id: 4, enabledByDefault: true }]);
    await t.run(plan({ kind: 'topics', count: 1 }));
    expect(t.categoryStore.saved.get('fixture')).toEqual([
      { name: '卡片交流', path: '/c/bank/6', id: 6, enabledByDefault: false },
      { name: 'General', path: '/c/general/4', id: 4, enabledByDefault: true },
    ]);
  });

  it('leaves the stored list untouched when the site shows the same categories', async () => {
    const discovered = site({ id: 'fixture', categorySource: 'discovered' });
    delete discovered.builtinCategories;
    const t = setup({ site: discovered, forum: { discovered: found } });
    await t.categoryStore.save('fixture', found);
    let saves = 0;
    const save = t.categoryStore.save.bind(t.categoryStore);
    t.categoryStore.save = async (id, list) => {
      saves++;
      await save(id, list);
    };
    await t.run(plan({ kind: 'topics', count: 1 }));
    expect(saves).toBe(0);
  });

  it('builtin sites never discover', async () => {
    const t = setup({ forum: { discovered: found } });
    await t.run(plan({ kind: 'topics', count: 1 }));
    expect(t.forum.calls.some((c) => c.op === 'discoverCategories')).toBe(false);
  });

  it('inspect reports ready and discovers on a discovered site (§8.2 step 7)', async () => {
    const discovered = site({ categorySource: 'discovered' });
    delete discovered.builtinCategories;
    const t = setup({ site: discovered, forum: { discovered: found } });
    const health = await t.time.drive(t.coordinator.inspect('fixture/main'));
    expect(health.status).toBe('ready');
    expect(t.categoryStore.saved.get('fixture')).toHaveLength(2);
  });

  it('inspect maps a held lock to locked and a lost session to needs-auth', async () => {
    const locked = setup({
      open: () => {
        throw new RunError('profile-locked', 'held');
      },
    });
    expect((await locked.time.drive(locked.coordinator.inspect('fixture/main'))).status).toBe('locked');
    const lost = setup({ forum: { auth: async () => ({ status: 'needs-auth' }) } });
    expect((await lost.time.drive(lost.coordinator.inspect('fixture/main'))).status).toBe('needs-auth');
  });
});

describe('AUTH-001 (kernel side) AuthSession', () => {
  it('rechecks without waiting, continues waiting on demand and closes the browser', async () => {
    const modes: AuthMode[] = [];
    const t = setup({
      forum: {
        auth: async (mode) => {
          modes.push(mode);
          return mode === 'headed-wait' ? { status: 'authenticated' } : { status: 'needs-auth' };
        },
      },
    });
    const session = await t.coordinator.beginAuth('fixture/main');
    expect((await session.recheck()).status).toBe('needs-auth');
    expect((await session.continueWaiting(new AbortController().signal)).status).toBe('authenticated');
    await session.close();
    expect(modes).toEqual(['headless-check', 'headed-wait']);
    expect(t.closed()).toBe(1);
  });
});

describe('STATE-001 browser closed from outside (§6.2)', () => {
  const closeAt = (t: ReturnType<typeof setup>, ms: number) => t.time.at(ms, () => t.browser.abort(stopRequest('browser-closed')));

  it('mid-browse: stopping → cancelled without verification, stats kept, browser session closed', async () => {
    const t = setup({ forum: { progress: async () => level(21, 175) } });
    closeAt(t, 40_000);
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-3)).toEqual(['browsing', 'stopping', 'cancelled']);
    expect(out).toMatchObject({ outcome: 'cancelled', stopCause: 'browser-closed' });
    expect(out.failure).toBeUndefined();
    expect(out.stats.confirmed.topics).toBeGreaterThan(0);
    expect(t.forum.calls.filter((c) => c.op === 'readProgress')).toHaveLength(1);
    expect(t.closed()).toBe(1);
  });

  it('during the initial progress read: no degraded run, stopping → cancelled', async () => {
    const t = setup({
      forum: {
        progress: (_kind, signal) => t.time.sleeper.sleep(10_000, signal).then(() => level(21, 175)),
      },
    });
    closeAt(t, 5_000);
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-3)).toEqual(['reading_initial_progress', 'stopping', 'cancelled']);
    expect(out.stopCause).toBe('browser-closed');
    expect(t.forum.calls.some((c) => c.op === 'collectTopics')).toBe(false);
  });

  it('during sign-in: awaiting_login → stopping → cancelled rather than failed', async () => {
    const t = setup({ signInAt: 300_000 });
    closeAt(t, 20_000);
    const out = await t.run(plan({ kind: 'endless' }, 'headed'));
    expect(t.states()).toEqual(['queued', 'launching', 'awaiting_login', 'stopping', 'cancelled']);
    expect(out).toMatchObject({ outcome: 'cancelled', stopCause: 'browser-closed' });
    expect(t.closed()).toBe(1);
  });

  it('ends a waiting AuthSession as a stop', async () => {
    const t = setup({ signInAt: 300_000 });
    const session = await t.coordinator.beginAuth('fixture/main');
    closeAt(t, 20_000);
    await expect(t.time.drive(session.continueWaiting(new AbortController().signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('S07 connect lag: one interruptible re-read of the final progress', () => {
  const connect = site({ progressSource: 'connect-linuxdo', progressUrl: 'https://connect.invalid' });
  const viewed = (topics: number): LevelSnapshot => ({
    source: 'connect-linuxdo',
    metrics: [{ label: '浏览话题', key: 'topicsViewed', current: topics, required: 500 }],
  });

  /** Initial read shows 100 topics; the n-th final read shows `finals[n]` (the last value repeats). */
  function lagging(finals: number[], onFinal?: (t: ReturnType<typeof setup>, n: number) => void) {
    const finalReadsAt: number[] = [];
    const t: ReturnType<typeof setup> = setup({
      site: connect,
      forum: {
        progress: async (kind) => {
          if (kind === 'initial') return viewed(100);
          const n = finalReadsAt.push(t.time.clock.monotonic()) - 1;
          onFinal?.(t, n);
          return viewed(finals[Math.min(n, finals.length - 1)]!);
        },
      },
    });
    const lagWarnings = () => t.events.filter((e) => e.type === 'warning' && e.code === 'site-lag');
    return { t, finalReadsAt, lagWarnings };
  }

  it('waits 4 minutes with the browser open and keeps the re-read once it catches up', async () => {
    const { t, finalReadsAt, lagWarnings } = lagging([100, 103]);
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(finalReadsAt).toHaveLength(2);
    expect(finalReadsAt[1]! - finalReadsAt[0]!).toBe(240_000);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target' });
    expect(out.stats.reported?.topicsViewed).toEqual({ initial: 100, final: 103 });
    expect(out.stats.confirmed.topics).toBe(3);
    expect(out.levels.final?.metrics[0]?.current).toBe(103);
    expect(lagWarnings()).toHaveLength(1);
    expect(t.closed()).toBe(1);
  });

  it('reads only once when the site already shows every confirmed topic', async () => {
    const { t, finalReadsAt, lagWarnings } = lagging([103]);
    await t.run(plan({ kind: 'topics', count: 3 }));
    expect(finalReadsAt).toHaveLength(1);
    expect(lagWarnings()).toHaveLength(0);
  });

  it('re-reads only once and reports the shortfall as it is, confirmed left untouched', async () => {
    const { t, finalReadsAt, lagWarnings } = lagging([100, 101]);
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(finalReadsAt).toHaveLength(2);
    expect(out.outcome).toBe('completed');
    expect(out.stats.reported?.topicsViewed).toEqual({ initial: 100, final: 101 });
    expect(out.stats.confirmed.topics).toBe(3);
    expect(lagWarnings()).toHaveLength(2);
  });

  it('a user stop during the wait keeps the first final read and still completes', async () => {
    const { t, finalReadsAt } = lagging([100, 103], (t, n) => {
      if (n === 0) t.time.at(t.time.clock.monotonic() + 60_000, () => t.controller.abort(stopRequest('user')));
    });
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(finalReadsAt).toHaveLength(1);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target' });
    expect(out.stats.reported?.topicsViewed).toEqual({ initial: 100, final: 100 });
    expect(t.events.some((e) => e.type === 'warning' && /Stopped while waiting/.test(e.message))).toBe(true);
  });

  it('a browser closed during the wait keeps the first final read, like a user stop', async () => {
    const { t, finalReadsAt } = lagging([100, 103], (t, n) => {
      if (n === 0) t.time.at(t.time.clock.monotonic() + 60_000, () => t.browser.abort(stopRequest('browser-closed')));
    });
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(finalReadsAt).toHaveLength(1);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target' });
    expect(out.failure).toBeUndefined();
    expect(out.stats.reported?.topicsViewed).toEqual({ initial: 100, final: 100 });
    expect(t.events.some((e) => e.type === 'warning' && /Stopped while waiting/.test(e.message))).toBe(true);
    expect(t.closed()).toBe(1);
  });

  it('a re-read that fails keeps the first final read and the outcome', async () => {
    let n = 0;
    const t = setup({
      site: connect,
      forum: {
        progress: async (kind) => {
          if (kind === 'initial') return viewed(100);
          if (n++ === 0) return viewed(100);
          throw new RunError('page-timeout', 'no progress');
        },
      },
    });
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target' });
    expect(out.levels.final?.metrics[0]?.current).toBe(100);
    expect(t.events.some((e) => e.type === 'warning' && e.code === 'final-progress-failed')).toBe(true);
  });

  it('a run the user already stopped still waits, and the second stop request cuts the wait', async () => {
    const exit = new AbortController();
    const finalReadsAt: number[] = [];
    const t: ReturnType<typeof setup> = setup({
      site: connect,
      exit,
      forum: {
        progress: async (kind) => {
          if (kind === 'initial') return viewed(100);
          finalReadsAt.push(t.time.clock.monotonic());
          t.time.at(t.time.clock.monotonic() + 120_000, () => exit.abort());
          return viewed(100);
        },
      },
    });
    t.time.at(40_000, () => t.controller.abort(stopRequest('user')));
    const out = await t.run(plan({ kind: 'endless' }));
    expect(out.stats.confirmed.topics).toBeGreaterThan(0);
    expect(finalReadsAt).toHaveLength(1);
    expect(out).toMatchObject({ outcome: 'cancelled', stopCause: 'app-exit' });
  });
});

describe('§5.1 progress page waiting on an authorization the run cannot get', () => {
  it('an initial read that ends in needs-auth stops the run as needs_auth instead of running without a baseline', async () => {
    const t = setup({
      forum: {
        progress: async () => {
          throw new RunError('needs-auth', 'connect.invalid asks to authorize access');
        },
      },
    });
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(t.states()).toEqual(['queued', 'launching', 'reading_initial_progress', 'needs_auth', 'cancelled']);
    expect(out).toMatchObject({ outcome: 'cancelled', failure: { code: 'needs-auth' } });
    expect(t.forum.calls.some((c) => c.op === 'collectTopics')).toBe(false);
    expect(t.closed()).toBe(1);
  });
});

describe('STATE-001 a failed end-of-run progress read (S07)', () => {
  const failingFinal = (code: 'page-timeout' | 'selector-contract-broken' = 'page-timeout') => async (kind: 'initial' | 'final') => {
    if (kind === 'initial') return level(21, 175);
    throw new RunError(code, 'final read broke');
  };
  const warnings = (t: ReturnType<typeof setup>, code: string) => t.events.filter((e) => e.type === 'warning' && e.code === code);

  it('a met target still completes: warning final-progress-failed, no final levels, no failure', async () => {
    const t = setup({ forum: { progress: failingFinal('selector-contract-broken') } });
    const out = await t.run(plan({ kind: 'topics', count: 3 }));
    expect(t.states().slice(-2)).toEqual(['verifying', 'completed']);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'target' });
    expect(out.failure).toBeUndefined();
    expect(out.levels.final).toBeNull();
    expect(warnings(t, 'final-progress-failed')).toHaveLength(1);
    expect(t.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a user stop still completes with stop cause user', async () => {
    const t = setup({ forum: { progress: failingFinal() } });
    t.time.at(40_000, () => t.controller.abort(stopRequest('user')));
    const out = await t.run(plan({ kind: 'endless' }));
    expect(t.states().slice(-4)).toEqual(['browsing', 'stopping', 'verifying', 'completed']);
    expect(out).toMatchObject({ outcome: 'completed', stopCause: 'user' });
    expect(out.failure).toBeUndefined();
    expect(warnings(t, 'final-progress-failed')).toHaveLength(1);
  });

  it('a browsing failure stays the failure; the read failure is only a warning', async () => {
    let collects = 0;
    const t = setup({
      forum: {
        progress: failingFinal(),
        topics: (path, call) => {
          if (++collects > 1) throw new RunError('network-failed', 'offline');
          return unread(path, call);
        },
      },
    });
    const out = await t.run(plan({ kind: 'endless' }));
    expect(out).toMatchObject({ outcome: 'failed', failure: { code: 'network-failed' } });
    expect(warnings(t, 'final-progress-failed')).toHaveLength(1);
  });
});

describe('STATE-001 terminal state after the browser is closed', () => {
  it('emits the terminal state only once the session (and its Profile lock) is closed', async () => {
    const t = setup({ forum: { progress: async (k) => level(k === 'initial' ? 21 : 24, 175) } });
    await t.run(plan({ kind: 'topics', count: 3 }));
    const terminal = t.events.findIndex((e) => e.type === 'state' && e.state === 'completed');
    expect(t.eventsAtClose()).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThanOrEqual(t.eventsAtClose());
  });

  it('also for a run that ends before browsing, with its error event', async () => {
    const t = setup({ forum: { auth: async () => ({ status: 'challenge-detected' }) } });
    await t.run(plan({ kind: 'endless' }));
    const after = t.events.slice(t.eventsAtClose());
    expect(after.map((e) => e.type)).toEqual(['error', 'state']);
    expect(after[1]).toMatchObject({ state: 'failed' });
  });
});

describe('inspect never rejects on a stopped check', () => {
  it('maps an AbortError from the check to broken', async () => {
    const t = setup({
      forum: {
        auth: async () => {
          throw new DOMException('The operation was aborted due to timeout', 'AbortError');
        },
      },
    });
    expect((await t.time.drive(t.coordinator.inspect('fixture/main'))).status).toBe('broken');
    expect(t.closed()).toBe(1);
  });

  it('maps a check that hangs until the browser closes to broken', async () => {
    const t = setup({
      forum: {
        auth: (_mode, signal) => t.time.sleeper.sleep(600_000, signal).then(() => ({ status: 'authenticated' as const })),
      },
    });
    t.time.at(10_000, () => t.browser.abort(stopRequest('browser-closed')));
    expect((await t.time.drive(t.coordinator.inspect('fixture/main'))).status).toBe('broken');
  });
});
