import { seededRandom, type ScheduleSpec } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { describe, expect, it } from 'vitest';
import { at, preset, spec } from './contract';
import { driveScheduler, LoopWaker } from './loop';
import { PlanScheduler } from './scheduler';
import { MemoryScheduleStore } from './store';

function setup() {
  const time = new VirtualTime(at('2026-10-08', '06:59'));
  const started: string[] = [];
  let ids = 0;
  const scheduler = new PlanScheduler({
    clock: time.clock,
    random: seededRandom(3),
    store: new MemoryScheduleStore(),
    newId: () => `id-${++ids}`,
    loadPreset: () => ({ preset: preset(5, 5), categories: [{ name: 'A', path: '/c/a/1', id: 1, enabledByDefault: true }] }),
    siteOf: () => 'linuxdo',
    profileBusy: () => false,
    displayAvailable: () => true,
    startRun: (plan) => {
      started.push(plan.plannedAt);
      return `run-${started.length}`;
    },
  });
  return { time, started, scheduler };
}

describe('driveScheduler', () => {
  it('fires planned runs as virtual time passes and stops on abort', async () => {
    const { time, started, scheduler } = setup();
    const ctrl = new AbortController();
    const specs: ScheduleSpec[] = [spec({ trigger: { kind: 'cron', expression: '0 7,8 * * *' } })];
    time.at(2 * 3_600_000, () => ctrl.abort());
    await time.drive(driveScheduler({ scheduler, loadSpecs: async () => specs, sleeper: time.sleeper, intervalMs: 30_000, signal: ctrl.signal, log: () => {} }));
    expect(started).toEqual([new Date(at('2026-10-08', '07:00')).toISOString(), new Date(at('2026-10-08', '08:00')).toISOString()]);
  });

  it('applies changed definitions and keeps going after a failing load', async () => {
    const { time, started, scheduler } = setup();
    const ctrl = new AbortController();
    const logs: string[] = [];
    let loads = 0;
    const loadSpecs = async () => {
      loads++;
      if (loads === 2) throw new Error('schedules.json is not valid JSON');
      return loads < 4 ? [] : [spec({ trigger: { kind: 'cron', expression: '30 7 * * *' } })];
    };
    time.at(3_600_000, () => ctrl.abort());
    await time.drive(driveScheduler({ scheduler, loadSpecs, sleeper: time.sleeper, intervalMs: 60_000, signal: ctrl.signal, log: (m) => logs.push(m) }));
    expect(logs).toEqual(['scheduler: schedules.json is not valid JSON']);
    expect(started).toEqual([new Date(at('2026-10-08', '07:30')).toISOString()]);
  });

  it('keeps ticking the last good definitions when new ones cannot be applied, and logs the error once', async () => {
    const { time, started, scheduler } = setup();
    const ctrl = new AbortController();
    const logs: string[] = [];
    let loads = 0;
    const good = [spec({ trigger: { kind: 'cron', expression: '0 7,8 * * *' } })];
    // From the second step on the file holds a trigger the scheduler cannot plan.
    const loadSpecs = async () => (++loads === 1 ? good : [spec({ trigger: { kind: 'cron', expression: '61 * * * *' } })]);
    time.at(2 * 3_600_000, () => ctrl.abort());
    await time.drive(driveScheduler({ scheduler, loadSpecs, sleeper: time.sleeper, intervalMs: 60_000, signal: ctrl.signal, log: (m) => logs.push(m) }));
    expect(started).toEqual([new Date(at('2026-10-08', '07:00')).toISOString(), new Date(at('2026-10-08', '08:00')).toISOString()]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/minute 61/);
  });

  it('fires the other schedules when one cannot start, and records that one as skipped', async () => {
    const time = new VirtualTime(at('2026-10-08', '06:59'));
    const started: string[] = [];
    const scheduler = new PlanScheduler({
      clock: time.clock,
      random: seededRandom(3),
      store: new MemoryScheduleStore(),
      newId: () => `id-${started.length}-${Math.random()}`,
      loadPreset: () => ({ preset: preset(5, 5), categories: [] }),
      siteOf: () => 'linuxdo',
      profileBusy: () => false,
      displayAvailable: () => true,
      startRun: (plan) => {
        if (plan.scheduleId === 'bad') throw new Error('Profile linuxdo/bad is in use');
        started.push(plan.scheduleId!);
        return `run-${started.length}`;
      },
    });
    const cron = { kind: 'cron' as const, expression: '0 7 * * *' };
    const ctrl = new AbortController();
    const logs: string[] = [];
    time.at(10 * 60_000, () => ctrl.abort());
    await time.drive(
      driveScheduler({
        scheduler,
        loadSpecs: async () => [spec({ id: 'bad', profileId: 'linuxdo/bad', trigger: cron }), spec({ id: 'good', trigger: cron })],
        sleeper: time.sleeper,
        intervalMs: 60_000,
        signal: ctrl.signal,
        log: (m) => logs.push(m),
      }),
    );
    expect(started).toEqual(['good']);
    expect(scheduler.history('bad').at(-1)).toMatchObject({ outcome: 'skipped', reason: 'start-failed' });
    expect(logs).toEqual(['scheduler: schedule bad: Profile linuxdo/bad is in use']);
  });

  it('applies definitions at once when woken, and answers the wake after that step', async () => {
    const { time, started, scheduler } = setup();
    const ctrl = new AbortController();
    const waker = new LoopWaker();
    let specs: ScheduleSpec[] = [];
    let wokenAt: number | null = null;
    time.at(60_000, () => {
      specs = [spec({ trigger: { kind: 'cron', expression: '30 7 * * *' } })];
      void waker.wake().then(() => {
        wokenAt = time.clock.now();
        expect(scheduler.views().map((v) => v.spec.id)).toEqual(['s1']);
      });
    });
    time.at(2 * 3_600_000, () => ctrl.abort());
    await time.drive(driveScheduler({ scheduler, loadSpecs: async () => specs, sleeper: time.sleeper, intervalMs: 30 * 60_000, signal: ctrl.signal, waker, log: () => {} }));
    // Woken a minute in, well before the half-hour step would have read the change.
    expect(wokenAt).toBe(at('2026-10-08', '06:59') + 60_000);
    expect(started).toEqual([new Date(at('2026-10-08', '07:30')).toISOString()]);
  });
});

describe('PlanScheduler persistence', () => {
  it('writes the state only when a step changed it', async () => {
    const time = new VirtualTime(at('2026-10-08', '06:00'));
    const store = new MemoryScheduleStore();
    let saves = 0;
    const counting = { load: () => store.load(), save: (s: Parameters<MemoryScheduleStore['save']>[0]) => (saves++, store.save(s)) };
    const scheduler = new PlanScheduler({
      clock: time.clock,
      random: seededRandom(3),
      store: counting,
      newId: () => 'id',
      loadPreset: () => ({ preset: preset(5, 5), categories: [] }),
      siteOf: () => 'linuxdo',
      profileBusy: () => false,
      displayAvailable: () => true,
      startRun: () => 'run',
    });
    await scheduler.reconcile([spec({ trigger: { kind: 'cron', expression: '0 8 * * *' } })]);
    const afterReconcile = saves;
    expect(afterReconcile).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await scheduler.tick();
    expect(saves).toBe(afterReconcile);
    await scheduler.pause('s1');
    expect(saves).toBe(afterReconcile + 1);
  });
});

