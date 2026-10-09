import { isAbortError, type InterruptibleSleeper, type ScheduleSpec } from '@disco-lurk/core';
import type { PlanScheduler } from './scheduler';

export interface DriveOptions {
  scheduler: PlanScheduler;
  /** Re-read every step, so definitions edited by another process take effect without a restart. */
  loadSpecs(): Promise<ScheduleSpec[]>;
  sleeper: InterruptibleSleeper;
  intervalMs: number;
  signal: AbortSignal;
  log(message: string): void;
}

/**
 * Reconciles on the first step and whenever the definitions change, ticks otherwise. A step that
 * cannot read or apply the definitions still ticks the schedules adopted from the last good copy,
 * so a broken definitions file never stops schedules that were already running. An error is
 * logged once until it changes or a step succeeds.
 */
export async function driveScheduler(opts: DriveOptions): Promise<void> {
  let applied: string | null = null;
  let reported: string | null = null;
  const report = (err: unknown) => {
    const message = `scheduler: ${err instanceof Error ? err.message : String(err)}`;
    if (message !== reported) opts.log(message);
    reported = message;
  };
  while (!opts.signal.aborted) {
    let failed = false;
    let specs: ScheduleSpec[] | null = null;
    try {
      specs = await opts.loadSpecs();
    } catch (err) {
      failed = true;
      report(err);
    }
    const key = specs ? JSON.stringify(specs) : null;
    let ticked = false;
    if (specs && key !== applied) {
      try {
        await opts.scheduler.reconcile(specs);
        applied = key;
        ticked = true;
      } catch (err) {
        failed = true;
        report(err);
      }
    }
    if (!ticked) {
      try {
        await opts.scheduler.tick();
      } catch (err) {
        failed = true;
        report(err);
      }
    }
    if (!failed) reported = null;
    try {
      await opts.sleeper.sleep(opts.intervalMs, opts.signal);
    } catch (err) {
      if (isAbortError(err)) return;
      throw err;
    }
  }
}
