import { seededRandom, type Category, type RunPlanSnapshot, type RunPreset, type ScheduleSpec, type TriggerCause } from '@disco-lurk/core';
import { describe, expect, it } from 'vitest';
import { dailyPoints } from './daily';
import { PlanScheduler, ScheduleSkipped, type SchedulerDeps } from './scheduler';
import { MemoryScheduleStore, type ScheduleStore } from './store';
import { localParts, zonedToEpoch } from './tz';

const TZ = 'Asia/Shanghai';
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, TZ);
};

const categories: Category[] = [
  { name: 'A', path: '/c/a/1', id: 1, enabledByDefault: true },
  { name: 'B', path: '/c/b/2', id: 2, enabledByDefault: true },
];

const preset = (min: number, max: number, paths = ['/c/a/1']): RunPreset => ({
  id: 'default',
  siteId: 'linuxdo',
  browseMode: 'deep',
  runMode: { kind: 'topics', min, max },
  categoryPaths: paths,
  interaction: { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5, riskAcknowledged: false } },
  extraWait: { enabled: true, minSec: 1, maxSec: 3 },
  samplePerCategory: { min: 3, max: 8 },
});

const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  id: 's1',
  name: 'daily',
  profileId: 'p1',
  presetId: 'default',
  enabled: true,
  browserMode: 'headless',
  timezone: TZ,
  trigger: { kind: 'daily-window', runs: 2, start: '07:00', end: '23:00', jitterMinutes: 15, minGapMinutes: 60 },
  misfire: { policy: 'skip', graceMinutes: 10 },
  overlap: 'skip',
  unavailableDisplay: 'skip',
  runOnStart: false,
  ...over,
});

/**
 * Each backing yields `open`, which returns a fresh store over the same persisted location, so a
 * second `open()` stands for a restarted process. The tests use only the `ScheduleStore` interface;
 * a file-backed implementation is covered by adding one entry here.
 */
const STORE_BACKINGS: Array<[string, () => () => ScheduleStore]> = [
  [
    'MemoryScheduleStore',
    () => {
      const cell = { data: null };
      return () => new MemoryScheduleStore(cell);
    },
  ],
];

function harness(startMs: number, open: () => ScheduleStore, seed = 11) {
  const store = open();
  const clock = { ms: startMs };
  const started: Array<{ plan: RunPlanSnapshot; cause: TriggerCause }> = [];
  const busy = new Set<string>();
  let display = true;
  let currentPreset = preset(15, 40);
  let ids = 0;
  const deps: SchedulerDeps = {
    clock: { now: () => clock.ms, monotonic: () => clock.ms },
    random: seededRandom(seed),
    store,
    newId: () => `id-${seed}-${++ids}`,
    loadPreset: () => ({ preset: currentPreset, categories }),
    siteOf: (profileId) => (profileId.startsWith('doc') ? 'docofcard' : 'linuxdo'),
    profileBusy: (profileId) => busy.has(profileId),
    displayAvailable: () => display,
    startRun: (plan, cause) => {
      started.push({ plan, cause });
      return `run-${started.length}`;
    },
  };
  return {
    clock,
    started,
    busy,
    persisted: () => open().load(),
    scheduler: new PlanScheduler(deps),
    setPreset: (p: RunPreset) => (currentPreset = p),
    setDisplay: (v: boolean) => (display = v),
    restart: (seedAfter = seed + 100) => harness(clock.ms, open, seedAfter),
  };
}

describe('daily-window points', () => {
  it('stay inside the window, keep the minimum gap, and only use the part of the day still ahead', () => {
    const w = { runs: 4, start: 420, end: 1380, jitterMinutes: 15, minGapMinutes: 90 };
    for (let seed = 1; seed <= 200; seed++) {
      const pts = dailyPoints(w, 0, seededRandom(seed));
      expect(pts).toHaveLength(4);
      pts.forEach((p, i) => {
        expect(p).toBeGreaterThanOrEqual(420);
        expect(p).toBeLessThanOrEqual(1380);
        if (i > 0) expect(p - pts[i - 1]!).toBeGreaterThanOrEqual(90);
      });
      expect(dailyPoints(w, 900, seededRandom(seed)).every((p) => p >= 900)).toBe(true);
    }
    expect(dailyPoints(w, 1381, seededRandom(1))).toEqual([]);
  });

  it('resolve local wall time in the schedule zone', () => {
    const ms = zonedToEpoch('2026-10-08', 7 * 60, TZ);
    expect(new Date(ms).toISOString()).toBe('2026-10-07T23:00:00.000Z');
    expect(localParts(ms, TZ)).toEqual({ date: '2026-10-08', minutes: 420 });
    expect(new Date(zonedToEpoch('2026-03-08', 150, 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe.each(STORE_BACKINGS)('with %s', (_name, backing) => {
  describe('SCHED-001 materialized runs are immutable', () => {
    it('fixes target and categories at planning time and runs exactly the snapshot it showed', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([spec()]);
      const shown = view!.next!;
      expect(shown.preset.runMode.kind).toBe('topics');
      const count = (shown.preset.runMode as { count: number }).count;
      expect(count).toBeGreaterThanOrEqual(15);
      expect(count).toBeLessThanOrEqual(40);
      expect(shown.siteId).toBe('linuxdo');
      expect(shown.preset.categories.map((c) => c.path)).toEqual(['/c/a/1']);

      h.setPreset(preset(90, 99, ['/c/b/2']));
      const [again] = await h.scheduler.reconcile([spec()]);
      expect(again!.next).toEqual(shown);

      h.clock.ms = Date.parse(shown.plannedAt);
      await h.scheduler.tick();
      expect(h.started).toHaveLength(1);
      expect(h.started[0]!.plan).toEqual(shown);
      expect(h.started[0]!.cause).toBe('planned');
    });

    it('keeps the same plan across a restart instead of regenerating the day', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [before] = await h.scheduler.reconcile([spec()]);
      const r = h.restart();
      const [after] = await r.scheduler.reconcile([spec()]);
      expect(after!.next).toEqual(before!.next);
      const stored = await h.persisted();
      expect(stored!.schedules.s1!.planned).toHaveLength(2);
    });

    it('plans the next local day only once that day arrives', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec()]);
      h.clock.ms = at('2026-10-09', '00:30');
      await h.scheduler.tick();
      const stored = await h.persisted();
      expect(stored!.schedules.s1!.generatedDays).toEqual(['2026-10-08', '2026-10-09']);
      expect(stored!.schedules.s1!.planned).toHaveLength(4);
    });
  });

  describe('SCHED-002 restarts and misfires', () => {
    it('runs run-on-start once, never again after a restart', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec({ runOnStart: true })]);
      expect(h.started.map((s) => s.cause)).toEqual(['run-on-start']);
      const r = h.restart();
      await r.scheduler.reconcile([spec({ runOnStart: true })]);
      expect(r.started).toEqual([]);
    });

    it('does not retry run-on-start after it was skipped', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      h.busy.add('p1');
      await h.scheduler.reconcile([spec({ runOnStart: true })]);
      expect(h.started).toEqual([]);
      const r = h.restart();
      await r.scheduler.reconcile([spec({ runOnStart: true })]);
      expect(r.started).toEqual([]);
    });

    it('marks runs missed while down as missed under policy skip', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec()]);
      h.clock.ms = at('2026-10-08', '23:30');
      const r = h.restart();
      await r.scheduler.reconcile([spec()]);
      expect(r.started).toEqual([]);
      expect(r.scheduler.history('s1').filter((e) => e.outcome === 'missed')).toHaveLength(2);
    });

    it('runs a single catch-up for any number of missed runs under policy run-once', async () => {
      const s = spec({ misfire: { policy: 'run-once', graceMinutes: 10 } });
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([s]);
      h.clock.ms = at('2026-10-08', '23:30');
      const r = h.restart();
      await r.scheduler.reconcile([s]);
      expect(r.started.map((x) => x.cause)).toEqual(['misfire']);
      const stored = await h.persisted();
      const lastPlanned = stored!.schedules.s1!.planned.at(-1)!.snapshot;
      expect(r.started[0]!.plan).toEqual(lastPlanned);
      expect(view!.next!.id).not.toBe(lastPlanned.id);
    });

    it('still runs a late run inside the grace period as planned', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([spec()]);
      h.clock.ms = Date.parse(view!.next!.plannedAt) + 9 * 60_000;
      const r = h.restart();
      await r.scheduler.reconcile([spec()]);
      expect(r.started.map((x) => x.cause)).toEqual(['planned']);
      expect(r.started[0]!.plan).toEqual(view!.next);
    });
  });

  describe('SCHED-003 overlap and missing display', () => {
    it('skips and records a run whose Profile is already running', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([spec()]);
      h.busy.add('p1');
      h.clock.ms = Date.parse(view!.next!.plannedAt);
      await h.scheduler.tick();
      expect(h.started).toEqual([]);
      expect(h.scheduler.history('s1').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'overlap' });
      await expect(h.scheduler.trigger('s1', 'manual')).rejects.toMatchObject({ reason: 'overlap' });
      await expect(h.scheduler.trigger('s1', 'manual')).rejects.toBeInstanceOf(ScheduleSkipped);
    });

    it('lets schedules on other Profiles (other sites) run concurrently', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec(), spec({ id: 's2', profileId: 'doc-main' })]);
      h.busy.add('p1');
      await expect(h.scheduler.trigger('s2', 'manual')).resolves.toBe('run-1');
      expect(h.started[0]!.plan.siteId).toBe('docofcard');
    });

    it('skips a headed run without a display by default', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const s = spec({ browserMode: 'headed' });
      const [view] = await h.scheduler.reconcile([s]);
      h.setDisplay(false);
      h.clock.ms = Date.parse(view!.next!.plannedAt);
      await h.scheduler.tick();
      expect(h.started).toEqual([]);
      expect(h.scheduler.history('s1').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'no-display' });
    });

    it('falls back to headless only when the schedule opts in, leaving the snapshot unchanged', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const s = spec({ browserMode: 'headed', unavailableDisplay: 'fallback-headless' });
      const [view] = await h.scheduler.reconcile([s]);
      h.setDisplay(false);
      h.clock.ms = Date.parse(view!.next!.plannedAt);
      await h.scheduler.tick();
      expect(h.started[0]!.plan).toEqual({ ...view!.next, browserMode: 'headless' });
      const stored = await h.persisted();
      expect(stored!.schedules.s1!.planned[0]!.snapshot.browserMode).toBe('headed');
      expect(h.scheduler.history('s1').at(-1)).toMatchObject({ outcome: 'started', reason: 'fallback-headless' });
    });

    it('starts nothing for a paused schedule', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([spec()]);
      await h.scheduler.pause('s1');
      h.clock.ms = Date.parse(view!.next!.plannedAt);
      await h.scheduler.tick();
      expect(h.started).toEqual([]);
    });
  });
});
