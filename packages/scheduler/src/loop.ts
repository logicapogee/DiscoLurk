import { isAbortError, type InterruptibleSleeper, type ScheduleSpec } from '@disco-lurk/core';
import type { PlanScheduler } from './scheduler';

export interface DriveOptions {
  scheduler: PlanScheduler;
  /** Re-read every step, so definitions edited by another process take effect without a restart. */
  loadSpecs(): Promise<ScheduleSpec[]>;
  sleeper: InterruptibleSleeper;
  intervalMs: number;
  signal: AbortSignal;
  /** Cuts a sleep short so changed definitions are applied at once. */
  waker?: LoopWaker;
  /** Runs after every step, e.g. to publish what the step changed. */
  afterStep?(): void;
  log(message: string): void;
}

/**
 * Wakes the scheduler loop. Writers of the definitions call `wake()` instead of reconciling
 * themselves, so only the loop ever applies them; the promise settles once a full step has run
 * after the wake.
 */
export class LoopWaker {
  private ctrl = new AbortController();
  private waiting: Array<() => void> = [];

  wake(): Promise<void> {
    const done = new Promise<void>((resolve) => this.waiting.push(resolve));
    this.ctrl.abort();
    return done;
  }

  /** Aborts when `wake()` is called during the current sleep. */
  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  /** Called as a step starts: the wakes so far are answered when it ends. */
  beginStep(): () => void {
    if (this.ctrl.signal.aborted) this.ctrl = new AbortController();
    const answered = this.waiting;
    this.waiting = [];
    return () => answered.forEach((resolve) => resolve());
  }

  /** Answers every wake; the loop has stopped. */
  release(): void {
    this.waiting.forEach((resolve) => resolve());
    this.waiting = [];
  }
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
  const waker = opts.waker ?? new LoopWaker();
  try {
    while (!opts.signal.aborted) {
      const answer = waker.beginStep();
      await step();
      opts.afterStep?.();
      answer();
      try {
        await opts.sleeper.sleep(opts.intervalMs, AbortSignal.any([opts.signal, waker.signal]));
      } catch (err) {
        if (!isAbortError(err)) throw err;
        if (opts.signal.aborted) return;
      }
    }
  } finally {
    waker.release();
  }

  async function step(): Promise<void> {
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
  }
}
