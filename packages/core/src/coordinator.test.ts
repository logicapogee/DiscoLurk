import { describe, expect, it } from 'vitest';
import { DiscoLurkCoordinator, reportedMetrics, type CategoryStore, type CoordinatorEnv } from './coordinator';
import { RunError, stopRequest, type RunEvent, type RunState } from './events';
import type { LevelSnapshot } from './metrics';
import type { AuthMode, AuthResult } from './ports';
import { FixtureForum, VirtualTime, type FixtureForumOptions } from './testing';
import type { BrowserMode, Category, RunMode, RunPlanSnapshot, Site, TopicCandidate } from './terms';

const site = (over: Partial<Site> = {}): Site => ({
  id: 'fixture',
  displayName: 'Fixture',
  baseUrl: 'https://forum.invalid',
  kind: 'discourse',
  login: 'headed',
  categorySource: 'builtin',
  builtinCategories: [],
  progressSource: 'trust-level-docofcard',
  progressUrl: 'https://forum.invalid/my/trust-level',
  behaviorVerified: { clickEntryRequired: 'unverified' },
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
  let closed = 0;
  const env: CoordinatorEnv = {
    deps: time.deps(1),
    resolveProfile: async (profileId) => ({ profile: { id: profileId, siteId: s.id, channel: 'chrome' }, site: s }),
    open: async () => {
      if (opts.open) opts.open();
      return {
        forum,
        close: async () => {
          closed++;
        },
      };
    },
    categories: categoryStore,
    ...(opts.exit ? { exitSignal: opts.exit.signal } : {}),
  };
  const coordinator = new DiscoLurkCoordinator(env);
  const events: RunEvent[] = [];
  const controller = new AbortController();
  const run = (p: RunPlanSnapshot) => time.drive(coordinator.run(p, controller.signal, (e) => events.push(e)));
  const states = () => events.filter((e) => e.type === 'state').map((e) => (e as { state: RunState }).state);
  return { time, forum, coordinator, events, controller, run, states, categoryStore, closed: () => closed };
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

  it('awaiting_login → cancelled when the user stops while waiting for sign-in', async () => {
    const t = setup({ signInAt: 300_000 });
    t.time.at(20_000, () => t.controller.abort(stopRequest('user')));
    const out = await t.run(plan({ kind: 'endless' }, 'headed'));
    expect(t.states()).toEqual(['queued', 'launching', 'awaiting_login', 'cancelled']);
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
