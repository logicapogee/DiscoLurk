import { seededRandom, type Category, type RunPlanSnapshot, type RunPreset, type ScheduleSpec, type TriggerCause } from '@disco-lurk/core';
import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, PlanScheduler, ScheduleSkipped, type SchedulerDeps } from './scheduler';
import type { ScheduleStore } from './store';
import { zonedToEpoch } from './tz';

// Scheduler behaviour every ScheduleStore must preserve. Each backing yields `open`, which returns a
// fresh store over the same persisted location, so a second `open()` stands for a restarted process.

export const TZ = 'Asia/Shanghai';
export const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, TZ);
};

const categories: Category[] = [
  { name: 'A', path: '/c/a/1', id: 1, enabledByDefault: true },
  { name: 'B', path: '/c/b/2', id: 2, enabledByDefault: true },
];

export const preset = (min: number, max: number, paths = ['/c/a/1']): RunPreset => ({
  id: 'default',
  siteId: 'linuxdo',
  browseMode: 'deep',
  runMode: { kind: 'topics', min, max },
  categoryPaths: paths,
  interaction: { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5, riskAcknowledged: false } },
  extraWait: { enabled: true, minSec: 1, maxSec: 3 },
  samplePerCategory: { min: 3, max: 8 },
});

export const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
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

export function harness(startMs: number, open: () => ScheduleStore, seed = 11) {
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

export function describeSchedulerContract(name: string, backing: () => () => ScheduleStore): void {
describe(`with ${name}`, () => {
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

  describe('cron trigger', () => {
    const cron = (expression: string, over: Partial<ScheduleSpec> = {}) => spec({ trigger: { kind: 'cron', expression }, ...over });

    it('materializes the next occurrence, runs that snapshot, then plans the following one', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [view] = await h.scheduler.reconcile([cron('30 8,20 * * *')]);
      expect(view!.next!.plannedAt).toBe(new Date(at('2026-10-08', '08:30')).toISOString());
      h.setPreset(preset(90, 99));
      h.clock.ms = at('2026-10-08', '08:30') + 20_000;
      await h.scheduler.tick();
      expect(h.started.map((s) => s.plan)).toEqual([view!.next]);
      const [after] = h.scheduler.views();
      expect(after!.next!.plannedAt).toBe(new Date(at('2026-10-08', '20:30')).toISOString());
      expect((after!.next!.preset.runMode as { count: number }).count).toBeGreaterThanOrEqual(90);
      await h.scheduler.tick();
      expect(h.started).toHaveLength(1);
    });

    it('keeps the same next run across a restart', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const [before] = await h.scheduler.reconcile([cron('*/20 * * * *')]);
      const r = h.restart();
      const [after] = await r.scheduler.reconcile([cron('*/20 * * * *')]);
      expect(after!.next).toEqual(before!.next);
    });

    it('records a run missed while down and plans from now under policy skip', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([cron('0 7 * * *')]);
      h.clock.ms = at('2026-10-08', '09:00');
      const r = h.restart();
      const [view] = await r.scheduler.reconcile([cron('0 7 * * *')]);
      expect(r.started).toEqual([]);
      expect(r.scheduler.history('s1').map((e) => e.outcome)).toEqual(['missed']);
      expect(view!.next!.plannedAt).toBe(new Date(at('2026-10-09', '07:00')).toISOString());
    });

    it('catches up once under policy run-once', async () => {
      const s = cron('0 7 * * *', { misfire: { policy: 'run-once', graceMinutes: 5 } });
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([s]);
      h.clock.ms = at('2026-10-08', '09:00');
      const r = h.restart();
      await r.scheduler.reconcile([s]);
      expect(r.started.map((x) => x.cause)).toEqual(['misfire']);
    });

    it('replans pending runs when the expression changes, keeping finished ones', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([cron('0 7 * * *')]);
      h.clock.ms = at('2026-10-08', '07:00');
      await h.scheduler.tick();
      const [view] = await h.scheduler.reconcile([cron('15 12 * * *')]);
      expect(view!.next!.plannedAt).toBe(new Date(at('2026-10-08', '12:15')).toISOString());
      const stored = await h.persisted();
      expect(stored!.schedules.s1!.planned.map((p) => p.status)).toEqual(['started', 'pending']);
    });

    it('rejects an invalid expression before persisting anything', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await expect(h.scheduler.reconcile([cron('61 * * * *')])).rejects.toThrow(/minute 61/);
      expect(await h.persisted()).toBeNull();
    });
  });

  describe('pause and resume', () => {
    it('skips runs due while paused and starts the next one after resume', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      const s = spec({ trigger: { kind: 'cron', expression: '0 8,9 * * *' } });
      await h.scheduler.reconcile([s]);
      await h.scheduler.pause('s1');
      h.clock.ms = at('2026-10-08', '08:00');
      await h.scheduler.tick();
      expect(h.scheduler.history('s1').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'paused' });
      const r = h.restart();
      await r.scheduler.reconcile([s]);
      expect(r.scheduler.views()[0]!.paused).toBe(true);
      await r.scheduler.resume('s1');
      r.clock.ms = at('2026-10-08', '09:00');
      await r.scheduler.tick();
      expect(r.started.map((x) => x.cause)).toEqual(['planned']);
    });
  });

  describe('run history', () => {
    it('records how a started run ended and survives a restart', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec()]);
      const runId = await h.scheduler.trigger('s1', 'manual');
      await h.scheduler.finish(runId, { outcome: 'failed', stopCause: 'error', failure: { code: 'needs-auth', message: 'x' } });
      const r = h.restart();
      await r.scheduler.reconcile([spec()]);
      expect(r.scheduler.history('s1').at(-1)).toMatchObject({ cause: 'manual', outcome: 'started', runId, ended: { outcome: 'failed', failure: 'needs-auth' } });
    });

    it(`keeps only the latest ${HISTORY_LIMIT} entries per schedule`, async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec()]);
      for (let i = 0; i < HISTORY_LIMIT + 5; i++) await h.scheduler.trigger('s1', 'manual');
      const stored = await h.persisted();
      const history = stored!.schedules.s1!.history;
      expect(history).toHaveLength(HISTORY_LIMIT);
      expect(history.at(-1)!.runId).toBe(`run-${HISTORY_LIMIT + 5}`);
    });

    it('forgets a removed schedule', async () => {
      const h = harness(at('2026-10-08', '06:00'), backing());
      await h.scheduler.reconcile([spec()]);
      await h.scheduler.remove('s1');
      expect((await h.persisted())!.schedules).toEqual({});
    });
  });

});
}
