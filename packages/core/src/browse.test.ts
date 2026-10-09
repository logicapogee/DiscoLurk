import { describe, expect, it } from 'vitest';
import { browse } from './browse';
import { emptyStats, type RunEvent } from './events';
import { targetReached } from './target';
import { FixtureForum, fixtureSite, VirtualTime } from './testing';
import { EXPERIMENTS_OFF, type BrowseMode, type Category, type RunMode, type RunPlanSnapshot, type TopicCandidate } from './terms';

const site = fixtureSite();

const categories: Category[] = ['a', 'b', 'c', 'd', 'e'].map((slug, i) => ({
  name: slug,
  path: `/c/${slug}/${i + 1}`,
  id: i + 1,
  enabledByDefault: true,
}));

function plan(runMode: RunMode, browseMode: BrowseMode = 'quick', extraWait = true): RunPlanSnapshot {
  return {
    id: 'run-1',
    siteId: site.id,
    profileId: 'p1',
    browserMode: 'headless',
    seed: 7,
    plannedAt: '2026-10-08T00:00:00.000Z',
    materializedAt: '2026-10-08T00:00:00.000Z',
    preset: {
      presetId: 'default',
      browseMode,
      runMode,
      categories,
      interaction: {
        like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
        reply: { enabled: false, rate: 5, riskAcknowledged: false },
      },
      extraWait: { enabled: extraWait, minSec: 1, maxSec: 3 },
      samplePerCategory: { min: 3, max: 8 },
      experiments: { ...EXPERIMENTS_OFF },
    },
  };
}

/** Each category always lists `perCategory` unread topics with ids unique per call. */
function rows(perCategory: number) {
  return (path: string, call: number): TopicCandidate[] =>
    Array.from({ length: perCategory }, (_, i) => ({ id: `${path}#${call}#${i}`, title: 't', unread: true, pinned: false }));
}

function setup(runMode: RunMode, opts: { browseMode?: BrowseMode; perCategory?: number; enters?: boolean } = {}) {
  const time = new VirtualTime();
  const forum = new FixtureForum({
    site,
    sleeper: time.sleeper,
    topics: rows(opts.perCategory ?? 1),
    enters: () => opts.enters ?? true,
  });
  const events: RunEvent[] = [];
  const controller = new AbortController();
  const p = plan(runMode, opts.browseMode);
  const run = () =>
    time.drive(browse({ plan: p, forum, deps: time.deps(p.seed), signal: controller.signal, emit: (e) => events.push(e) }));
  return { time, forum, events, controller, run };
}

const collectOrder = (forum: FixtureForum) =>
  forum.calls.filter((c) => c.op === 'collectTopics').map((c) => (c as { category: string }).category);

describe('TARGET-001 target metrics (S03, S04)', () => {
  it('counts topics only in quick mode and topics plus floors in deep mode', () => {
    const stats = emptyStats();
    stats.confirmed.topics = 3;
    stats.confirmed.floors = 10;
    stats.estimatedFloors = 50;
    expect(targetReached({ kind: 'topics', count: 4 }, 'quick', stats)).toBe(false);
    expect(targetReached({ kind: 'topics', count: 3 }, 'quick', stats)).toBe(true);
    expect(targetReached({ kind: 'topics', count: 13 }, 'deep', stats)).toBe(true);
    expect(targetReached({ kind: 'topics', count: 14 }, 'deep', stats)).toBe(false);
  });

  it('never counts estimated floors toward a deep target', async () => {
    const time = new VirtualTime();
    const forum = new FixtureForum({ site, sleeper: time.sleeper, topics: rows(1), floorsConfirmed: false });
    const p = plan({ kind: 'topics', count: 3 }, 'deep');
    const out = await time.drive(
      browse({ plan: p, forum, deps: time.deps(p.seed), signal: new AbortController().signal, emit: () => {} }),
    );
    expect(out.end).toBe('target-reached');
    expect(out.stats.confirmed.topics).toBe(3);
    expect(out.stats.confirmed.floors).toBe(0);
    expect(out.stats.estimatedFloors).toBeGreaterThan(0);
  });

  it('stops a deep run in the middle of a topic once topics + floors meet the target (F06)', async () => {
    const { forum, run } = setup({ kind: 'topics', count: 3 }, { browseMode: 'deep' });
    const out = await run();
    expect(out.end).toBe('target-reached');
    // One topic entered (1) plus two confirmed floor steps (1→2→3) reaches 3.
    expect(out.stats.confirmed.topics).toBe(1);
    expect(out.stats.confirmed.floors).toBe(2);
    expect(forum.calls.filter((c) => c.op === 'performActions')).toHaveLength(0);
  });

  it('measures time targets on the monotonic clock, unaffected by wall-clock jumps', async () => {
    const { time, run } = setup({ kind: 'time', minutes: 2 });
    time.at(1000, () => time.jumpWallClock(60 * 60_000));
    const out = await run();
    expect(out.end).toBe('target-reached');
    expect(out.stats.elapsedMs).toBeGreaterThanOrEqual(120_000);
    expect(out.stats.elapsedMs).toBeLessThan(120_000 + 30_000);
  });
});

describe('RUN-001 rounds continue until the target (S01, S02)', () => {
  it('quantity mode keeps rotating rounds past the first one', async () => {
    const { forum, run } = setup({ kind: 'topics', count: 12 });
    const out = await run();
    expect(out.end).toBe('target-reached');
    expect(out.stats.confirmed.topics).toBe(12);
    // Five categories with one topic each: twelve topics need three rounds.
    expect(collectOrder(forum).length).toBeGreaterThan(10);
  });

  it('time mode keeps rotating rounds until the duration elapses', async () => {
    const { forum, run } = setup({ kind: 'time', minutes: 10 });
    const out = await run();
    expect(out.end).toBe('target-reached');
    expect(out.stats.elapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(collectOrder(forum).length).toBeGreaterThan(categories.length * 2);
  });

  it('endless mode runs until stopped and reshuffles the category order each round', async () => {
    const { time, forum, controller, run } = setup({ kind: 'endless' });
    time.at(60 * 60_000, () => controller.abort());
    const out = await run();
    expect(out.end).toBe('cancelled');
    const order = collectOrder(forum);
    const rounds: string[][] = [];
    for (let i = 0; i + categories.length <= order.length; i += categories.length) {
      rounds.push(order.slice(i, i + categories.length));
    }
    expect(rounds.length).toBeGreaterThan(5);
    for (const r of rounds) expect(new Set(r).size).toBe(categories.length);
    expect(new Set(rounds.map((r) => r.join())).size).toBeGreaterThan(1);
  });
});

describe('RUN-002 no-progress breaker (S06)', () => {
  it('ends after one round in which no topic could be entered', async () => {
    const { forum, run } = setup({ kind: 'endless' }, { enters: false });
    const out = await run();
    expect(out.end).toBe('no-progress');
    expect(out.stats.confirmed.topics).toBe(0);
    expect(out.stats.attempted.topics).toBe(categories.length);
    expect(collectOrder(forum)).toHaveLength(categories.length);
  });

  it('ends after one round when every category is empty', async () => {
    const { forum, run } = setup({ kind: 'topics', count: 5 }, { perCategory: 0 });
    const out = await run();
    expect(out.end).toBe('no-progress');
    expect(collectOrder(forum)).toHaveLength(categories.length);
  });
});

describe('STOP-003 stop takes effect within 2 s at every level (S05)', () => {
  // Stop instants chosen to land inside: a category load, a click, a reading dwell,
  // the return-to-list wait, and the between-topic / between-category pauses.
  const stopPoints = [500, 1500, 2500, 4000, 7000, 12_000, 13_500, 21_000, 33_000, 47_000, 61_000, 95_000];

  it.each(stopPoints)('stop at %i ms resolves within 2 s and starts nothing afterwards', async (stopAt) => {
    const { time, forum, controller, run } = setup({ kind: 'endless' }, { perCategory: 3 });
    let callsAtStop = -1;
    let stoppedAt = 0;
    time.at(stopAt, () => {
      callsAtStop = forum.calls.length;
      stoppedAt = time.clock.monotonic();
      controller.abort();
    });
    const out = await run();
    expect(out.end).toBe('cancelled');
    expect(time.clock.monotonic() - stoppedAt).toBeLessThanOrEqual(2000);
    expect(forum.calls.length).toBe(callsAtStop);
  });

  it('a stop before the run starts ends it without touching the forum', async () => {
    const { forum, controller, run } = setup({ kind: 'endless' });
    controller.abort();
    const out = await run();
    expect(out.end).toBe('cancelled');
    expect(forum.calls).toHaveLength(0);
  });
});

describe('Appendix B: 1–2 s after reading, whatever the extra-wait switch says', () => {
  it.each([true, false])('pauses 1–2 s between reading and returning (extra wait %s)', async (extraWait) => {
    const time = new VirtualTime();
    const marks: Array<{ op: string; at: number }> = [];
    class Timed extends FixtureForum {
      override async readTopic(...args: Parameters<FixtureForum['readTopic']>) {
        const r = await super.readTopic(...args);
        marks.push({ op: 'read-done', at: time.clock.monotonic() });
        return r;
      }
      override async returnAndVerify(...args: Parameters<FixtureForum['returnAndVerify']>) {
        marks.push({ op: 'return', at: time.clock.monotonic() });
        return super.returnAndVerify(...args);
      }
    }
    const forum = new Timed({ site, sleeper: time.sleeper, topics: rows(1) });
    const p = plan({ kind: 'topics', count: 3 }, 'quick', extraWait);
    await time.drive(browse({ plan: p, forum, deps: time.deps(p.seed), signal: new AbortController().signal, emit: () => {} }));
    const gaps = marks.flatMap((m, i) => (m.op === 'read-done' && marks[i + 1]?.op === 'return' ? [marks[i + 1]!.at - m.at] : []));
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1_000);
      expect(gap).toBeLessThanOrEqual(2_000);
    }
  });
});
