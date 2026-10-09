import { seededRandom, type ScheduleSpec } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { describe, expect, it } from 'vitest';
import { at, preset, spec } from './contract';
import { driveScheduler } from './loop';
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
});
