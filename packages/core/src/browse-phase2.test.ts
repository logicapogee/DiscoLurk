import { describe, expect, it } from 'vitest';
import { browse } from './browse';
import type { RunEvent } from './events';
import { MemoryLedger, rankTopics, topicScore } from './ledger';
import type { ActionPolicy, ActionResult, ReadVerification } from './ports';
import { seededRandom } from './runtime';
import { FixtureForum, fixtureSite, NO_ACTIONS, VirtualTime, type FixtureForumOptions } from './testing';
import { TimingsTally } from './timings';
import type { BrowseMode, Category, ExperimentFlags, InteractionPolicy, RunMode, RunPlanSnapshot, TopicCandidate } from './terms';

const site = fixtureSite();
const categories: Category[] = ['a', 'b', 'c'].map((slug, i) => ({ name: slug, path: `/c/${slug}/${i + 1}`, id: i + 1, enabledByDefault: true }));
const OFF: InteractionPolicy = { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5 } };

interface PlanOpts {
  browseMode?: BrowseMode;
  interaction?: InteractionPolicy;
  experiments?: ExperimentFlags;
  extraWait?: boolean;
}

function plan(runMode: RunMode, o: PlanOpts = {}): RunPlanSnapshot {
  return {
    id: 'run-1',
    siteId: site.id,
    profileId: 'fixture/main',
    browserMode: 'headless',
    seed: 3,
    plannedAt: '2026-10-08T00:00:00.000Z',
    materializedAt: '2026-10-08T00:00:00.000Z',
    preset: {
      presetId: 'p',
      browseMode: o.browseMode ?? 'quick',
      runMode,
      categories,
      interaction: o.interaction ?? OFF,
      extraWait: { enabled: o.extraWait ?? true, minSec: 1, maxSec: 3 },
      samplePerCategory: { min: 3, max: 8 },
      ...(o.experiments ? { experiments: o.experiments } : {}),
    },
  };
}

const unreadRows = (n: number) => (path: string, call: number): TopicCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${path}#${call}#${i}`, title: 't', unread: true, pinned: false }));

function run(p: RunPlanSnapshot, forumOpts: Partial<Omit<FixtureForumOptions, 'site' | 'sleeper'>> = {}, extra: { tally?: TimingsTally; ledger?: MemoryLedger } = {}) {
  const time = new VirtualTime();
  const forum = new FixtureForum({ site, sleeper: time.sleeper, topics: unreadRows(4), ...forumOpts });
  if (extra.tally) forum.onTimings = (r) => extra.tally!.add(r);
  const events: RunEvent[] = [];
  const controller = new AbortController();
  const go = () =>
    time.drive(
      browse({
        plan: p,
        forum,
        deps: time.deps(p.seed),
        signal: controller.signal,
        emit: (e) => events.push(e),
        ...(extra.tally ? { timings: extra.tally } : {}),
        ...(extra.ledger ? { ledger: extra.ledger } : {}),
      }),
    );
  return { time, forum, events, controller, go };
}

const ops = (forum: FixtureForum, op: string) => forum.calls.filter((c) => c.op === op);

describe('TARGET-001 time target ends within the topic (S04)', () => {
  it('cuts reading at the deadline instead of finishing the topic, then still returns to the list', async () => {
    // A reading of 60 dwell steps of 3 s would take 180 s; the 1-minute target must end it at 60 s.
    const floors = Array.from({ length: 61 }, (_, i) => i + 1);
    const t = run(plan({ kind: 'time', minutes: 1 }), { floors: () => floors, latency: { collect: 1000, enter: 1000, dwell: 3000, back: 2500 } });
    const out = await t.go();
    expect(out.end).toBe('target-reached');
    expect(ops(t.forum, 'readTopic')).toHaveLength(1);
    expect(ops(t.forum, 'returnAndVerify')).toHaveLength(1);
    // 60 s deadline, then 1–2 s after reading and 2.5 s back to the list.
    expect(t.time.clock.monotonic()).toBeLessThanOrEqual(60_000 + 2_000 + 2_500);
    expect(out.stats.elapsedMs).toBeGreaterThanOrEqual(60_000);
  });

  it('enters no topic once the time ran out during a pause', async () => {
    const t = run(plan({ kind: 'time', minutes: 1 }), { floors: () => [1, 2], latency: { collect: 1000, enter: 1000, dwell: 1000, back: 1000 } });
    await t.go();
    const entersAfterDeadline = t.events.filter((e) => e.type === 'topic' && e.phase === 'click' && Date.parse(e.at) - Date.UTC(2026, 9, 8) > 60_000);
    expect(entersAfterDeadline).toEqual([]);
  });
});

describe('STATS-001 three-layer statistics (§6.4)', () => {
  it('fills attempted, confirmed, estimated, returns and the timings receipt', async () => {
    const tally = new TimingsTally();
    const verdicts: ReadVerification[] = ['confirmed', 'still-unread', 'indeterminate'];
    let n = 0;
    const t = run(
      plan({ kind: 'topics', count: 3 }),
      {
        enters: (topic) => !topic.id.endsWith('#3'),
        verify: () => verdicts[n++ % verdicts.length]!,
        floors: () => [1, 3],
        timings: (topic) => [
          { topicId: topic.id, postNumbers: [1, 2], topicMs: 4_000 },
          { topicId: topic.id, postNumbers: [2, 3], topicMs: 2_000 },
        ],
      },
      { tally },
    );
    const out = await t.go();
    const s = out.stats;
    expect(s.confirmed.topics).toBe(3);
    expect(s.attempted.topics).toBeGreaterThanOrEqual(3);
    expect(s.returns).toEqual({ confirmed: 1, 'still-unread': 1, indeterminate: 1, 'not-applicable': 0 });
    // Floors 2 is reported twice per topic but counted once.
    expect(s.timings).toEqual({ posts: 9, topicSeconds: 18 });
    // Two topics read 1 → 3; the third met the target on entry and was not read.
    expect(s.confirmed.floors).toBe(4);
    const stats = t.events.filter((e) => e.type === 'stats');
    expect(stats.at(-1)).toMatchObject({ stats: { timings: { posts: 9 } } });
  });

  it('a still-unread return is counted and warned about; the topic still counts as confirmed by entry', async () => {
    const t = run(plan({ kind: 'topics', count: 1 }), { verify: () => 'still-unread' });
    const out = await t.go();
    expect(out.stats.confirmed.topics).toBe(1);
    expect(out.stats.returns['still-unread']).toBe(1);
    expect(t.events.some((e) => e.type === 'warning' && e.code === 'still-unread')).toBe(true);
  });

  it('estimated floors never reach confirmed floors or a deep target', async () => {
    const t = run(plan({ kind: 'topics', count: 4 }, { browseMode: 'deep' }), { floors: () => [0, 1, 2], floorsConfirmed: false });
    const out = await t.go();
    expect(out.stats.confirmed.floors).toBe(0);
    expect(out.stats.estimatedFloors).toBeGreaterThan(0);
    expect(out.stats.confirmed.topics).toBe(4);
  });
});

const liked = (over: Partial<ActionResult> = {}): ActionResult => ({ ...structuredClone(NO_ACTIONS), ...over });

describe('ACTION-000 interactions are off unless switched on (A01, A02)', () => {
  it('never calls performActions with likes and replies off', async () => {
    const t = run(plan({ kind: 'topics', count: 3 }));
    await t.go();
    expect(ops(t.forum, 'performActions')).toHaveLength(0);
  });

  it('calls performActions once per read topic with the policy, its pacing and an event sink', async () => {
    const seen: ActionPolicy[] = [];
    const interaction: InteractionPolicy = { ...OFF, like: { ...OFF.like, enabled: true } };
    const t = run(plan({ kind: 'topics', count: 2 }, { interaction }), {
      actions: async (policy) => {
        seen.push(policy);
        policy.onAction({ action: 'like', result: 'attempted', postNumber: 1 });
        policy.onAction({ action: 'like', result: 'confirmed', postNumber: 1 });
        return liked({ likes: { attempted: 1, confirmed: 1 }, replyLikes: { attempted: 2, confirmed: 1 } });
      },
    });
    const out = await t.go();
    // The second topic meets the count target on entry, so it is never interacted with.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.extraWait).toEqual({ enabled: true, minSec: 1, maxSec: 3 });
    expect(out.stats.attempted).toMatchObject({ likes: 1, replyLikes: 2 });
    expect(out.stats.confirmed).toMatchObject({ likes: 1, replyLikes: 1 });
    expect(t.events.filter((e) => e.type === 'action').map((e) => (e as { result: string }).result)).toEqual(['attempted', 'confirmed']);
  });

  it('counts replied topics once per topic however many replies it got', async () => {
    const interaction: InteractionPolicy = { ...OFF, reply: { enabled: true, rate: 100 } };
    const t = run(plan({ kind: 'topics', count: 30 }, { interaction }), {
      actions: async () => liked({ replies: { attempted: 2, confirmed: 2 } }),
    });
    const out = await t.go();
    const read = ops(t.forum, 'performActions').length;
    expect(out.stats.confirmed.replies).toBe(read * 2);
    expect(out.stats.confirmed.repliedTopics).toBe(read);
  });
});

describe('STOP-001 a met target cancels interaction (F06)', () => {
  it('never interacts on the topic whose floors met a deep target', async () => {
    const interaction: InteractionPolicy = { ...OFF, like: { ...OFF.like, enabled: true } };
    const t = run(plan({ kind: 'topics', count: 4 }, { browseMode: 'deep', interaction }), { floors: () => [1, 2, 3, 4, 5, 6] });
    const out = await t.go();
    expect(out.end).toBe('target-reached');
    expect(ops(t.forum, 'performActions')).toHaveLength(0);
  });
});

describe('STOP-002 a stop is checked before interacting (A08)', () => {
  it('a stop during the pause after reading never reaches performActions', async () => {
    const interaction: InteractionPolicy = { ...OFF, like: { ...OFF.like, enabled: true } };
    const t = run(plan({ kind: 'endless' }, { interaction }), { floors: () => [1, 2], latency: { collect: 1000, enter: 1000, dwell: 3000, back: 2500 } });
    // Collect 1 s + enter 1 s + one 3 s dwell ends reading at 5 s; the 1–2 s pause follows.
    t.time.at(5_500, () => t.controller.abort());
    const out = await t.go();
    expect(out.end).toBe('cancelled');
    expect(ops(t.forum, 'performActions')).toHaveLength(0);
  });
});

describe('LIKE-003 two unconfirmed likes in a row end liking for the run (A09)', () => {
  it('turns likes off after the adapter reports the limit and warns like-limit once', async () => {
    const interaction: InteractionPolicy = { like: { ...OFF.like, enabled: true }, reply: { enabled: true, rate: 5 } };
    const policies: Array<{ like: boolean }> = [];
    let calls = 0;
    const t = run(plan({ kind: 'topics', count: 12 }, { interaction }), {
      actions: async (policy) => {
        policies.push({ like: policy.like.enabled });
        calls++;
        return liked({ likes: { attempted: 1, confirmed: 0 }, likeLimitHit: calls >= 2 });
      },
    });
    await t.go();
    expect(policies.slice(0, 2).every((p) => p.like)).toBe(true);
    expect(policies.slice(2).every((p) => !p.like)).toBe(true);
    expect(t.events.filter((e) => e.type === 'warning' && e.code === 'like-limit')).toHaveLength(1);
  });
});

describe('experiments stay off by default (§7.2)', () => {
  it('asks only for the category list without flags', async () => {
    const t = run(plan({ kind: 'topics', count: 2 }));
    await t.go();
    expect(t.forum.strategies.every((s) => (s.lists ?? []).length === 0)).toBe(true);
  });

  it('useNewList / useUnreadList ask for the filtered lists first, in that order', async () => {
    const t = run(plan({ kind: 'topics', count: 2 }, { experiments: { useNewList: true, useUnreadList: true, refreshCategories: false, smartRanked: false } }));
    await t.go();
    expect(t.forum.strategies[0]!.lists).toEqual(['new', 'unread']);
  });

  it('smartRanked takes the best scored candidates from the ledger', async () => {
    const ledger = new MemoryLedger();
    const now = Date.UTC(2026, 9, 8);
    const rows: TopicCandidate[] = [
      { id: 'fresh', title: '', unread: true, pinned: false, replies: 200 },
      { id: 'seen', title: '', unread: false, pinned: false, replies: 500 },
      { id: 'failing', title: '', unread: false, pinned: false, replies: 50 },
      { id: 'quiet', title: '', unread: false, pinned: false, replies: 0 },
    ];
    ledger.record({ topicId: 'seen', lastVisitAt: new Date(now - 3_600_000).toISOString(), entered: true });
    for (let i = 0; i < 3; i++) ledger.record({ topicId: 'failing', lastVisitAt: new Date(now - 30 * 86_400_000).toISOString(), entered: false, failure: 'click-failed' });
    expect(topicScore(rows[0]!, undefined, now)).toBeGreaterThan(topicScore(rows[1]!, ledger.get('seen'), now));
    const picked = rankTopics(rows, ledger, now, seededRandom(1), { min: 2, max: 2 });
    expect(picked.map((t) => t.id)).toEqual(['fresh', 'quiet']);
  });
});

describe('visit ledger (§7.2)', () => {
  it('records every visit, entered or not, with floors and verification', async () => {
    const ledger = new MemoryLedger();
    let clicks = 0;
    const t = run(plan({ kind: 'topics', count: 2 }), { enters: () => clicks++ > 0, floors: () => [4, 6] }, { ledger });
    await t.go();
    const records = [...ledger.records.values()];
    expect(records.some((r) => !r.entered && r.failure === 'click-not-confirmed' && r.failures === 1)).toBe(true);
    expect(records.some((r) => r.entered && r.floors?.from === 4 && r.floors.to === 6 && r.verification === 'confirmed')).toBe(true);
  });
});
