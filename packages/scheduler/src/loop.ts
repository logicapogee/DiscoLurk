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
 * Reconciles on the first step and whenever the definitions change, ticks otherwise. A failing
 * step is logged and retried on the next one: a broken definitions file must not stop schedules
 * that were already running from the last good copy.
 */
export async function driveScheduler(opts: DriveOptions): Promise<void> {
  let applied: string | null = null;
  while (!opts.signal.aborted) {
    try {
      const specs = await opts.loadSpecs();
      const key = JSON.stringify(specs);
      if (key !== applied) {
        await opts.scheduler.reconcile(specs);
        applied = key;
      } else {
        await opts.scheduler.tick();
      }
    } catch (err) {
      opts.log(`scheduler: ${(err as Error).message}`);
    }
    try {
      await opts.sleeper.sleep(opts.intervalMs, opts.signal);
    } catch (err) {
      if (isAbortError(err)) return;
      throw err;
    }
  }
}
