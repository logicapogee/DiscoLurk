import {
  systemRandom,
  type Clock,
  type InterruptibleSleeper,
  type RandomSource,
  type RunPreset,
  type ScheduleSpec,
  type TriggerCause,
} from '@disco-lurk/core';
import { openScheduler, SchedulerLockedError, type OpenedScheduler, type ScheduleBook } from '@disco-lurk/config';
import { driveScheduler, LoopWaker, ScheduleSkipped, validateTrigger, type HistoryEntry } from '@disco-lurk/scheduler';
import type { ScheduleList, StoredPreset } from './contract';
import { HttpError, type EventHub } from './hub';
import type { ProfileGate, RunManager, SiteCatalog } from './runs';
import { splitProfileId, type PresetStore } from './store';

export const SCHEDULE_TICK_MS = 30_000;

export interface ScheduleServiceDeps {
  clock: Clock;
  sleeper: InterruptibleSleeper;
  random?: RandomSource;
  /** `<appData>/disco-lurk`; the schedules live in its `schedules` directory. */
  dataDir: string;
  presets: PresetStore;
  catalog: SiteCatalog;
  runs: RunManager;
  gate: ProfileGate;
  hub: EventHub;
  displayAvailable(): boolean;
  /** Schedules defined outside the file, such as `lurk serve`'s LURK_* schedule; read on every step. */
  extraSchedules?(): Promise<ScheduleBook>;
  intervalMs?: number;
  log(message: string): void;
}

/** The run settings a schedule copies out of a UI preset; where and how it runs belong to the schedule. */
export function runPresetOf(p: StoredPreset): RunPreset {
  const { name: _n, profileId: _p, browserMode: _b, ...preset } = structuredClone(p);
  return preset;
}

/**
 * The schedules over the scheduler `openScheduler` hands out: definitions in `schedules.json`
 * (shared with `lurk schedule`), plans and history in `state.json`. A schedule made in the UI
 * carries a copy of its preset in that file, kept current whenever the preset is saved, so the
 * CLI and a later `lurk serve` read the same definition. Only the loop applies definitions;
 * writers wake it and wait for that step.
 */
export class ScheduleService {
  private opened: OpenedScheduler | null = null;
  private unavailable: string | null = null;
  private presetsInUse: RunPreset[] = [];
  private loop: Promise<void> | null = null;
  private readonly loopStop = new AbortController();
  private readonly waker = new LoopWaker();

  constructor(private readonly deps: ScheduleServiceDeps) {}

  /**
   * Takes the state lock; another owner leaves the service answering 409. With `loop` the
   * schedules are planned and fired until `stop()`; without it (a one-off CLI command) the
   * current definitions are only adopted.
   */
  async start(opts: { loop?: boolean } = {}): Promise<void> {
    let seq = 0;
    try {
      this.opened = await openScheduler({
        dataDir: this.deps.dataDir,
        deps: {
          clock: this.deps.clock,
          random: this.deps.random ?? systemRandom,
          newId: () => `run-${this.deps.clock.now()}-s${(seq++).toString(36)}`,
          loadPreset: (presetId) => {
            const preset = this.presetsInUse.find((p) => p.id === presetId);
            if (!preset) throw new Error(`Preset ${presetId} does not exist`);
            return { preset, categories: this.deps.catalog.categoriesFor(preset) };
          },
          siteOf: (profileId) => splitProfileId(profileId).siteId,
          profileBusy: (profileId) => this.deps.gate.isBusy(profileId),
          displayAvailable: this.deps.displayAvailable,
          startRun: (plan) => {
            const name = this.deps.presets.get(plan.preset.presetId)?.name ?? plan.preset.presetId;
            return this.deps.runs.launch(plan, name, (result) => this.finished(plan.id, result)).runId;
          },
          warn: (code, message) => this.deps.log(`schedule ${code}: ${message}`),
        },
      });
    } catch (err) {
      if (!(err instanceof SchedulerLockedError)) throw err;
      this.unavailable = `${err.message}; manage schedules there`;
      this.deps.log(`schedules: ${this.unavailable}`);
      return;
    }
    if (opts.loop === false) {
      await this.opened.scheduler.adopt(await this.loadSpecs());
      return;
    }
    this.loop = driveScheduler({
      scheduler: this.opened.scheduler,
      loadSpecs: () => this.loadSpecs(),
      sleeper: this.deps.sleeper,
      intervalMs: this.deps.intervalMs ?? SCHEDULE_TICK_MS,
      signal: this.loopStop.signal,
      waker: this.waker,
      afterStep: () => this.publish(),
      log: this.deps.log,
    });
  }

  /** Stops planning; runs already started keep reporting their ends until `close()`. */
  async stop(): Promise<void> {
    this.loopStop.abort();
    await this.loop;
  }

  /** Gives up the state lock; call it once the runs this scheduler started have ended. */
  async close(): Promise<void> {
    await this.stop();
    await this.opened?.close();
    this.opened = null;
  }

  get available(): boolean {
    return this.opened !== null;
  }

  /** Why another process owns the schedules, while it does. */
  get unavailableReason(): string | null {
    return this.unavailable;
  }

  private owned(): OpenedScheduler {
    if (!this.opened) throw new HttpError(409, 'schedules-unavailable', this.unavailable ?? 'Schedules are not loaded');
    return this.opened;
  }

  private scheduler() {
    return this.owned().scheduler;
  }

  private async finished(runId: string, result: Parameters<OpenedScheduler['scheduler']['finish']>[1]): Promise<void> {
    await this.scheduler().finish(runId, result);
    this.publish();
  }

  private publish(): void {
    this.deps.hub.publish({ type: 'schedules', list: this.list() });
  }

  private async loadSpecs(): Promise<ScheduleSpec[]> {
    const book = await this.owned().book.load();
    const extra = (await this.deps.extraSchedules?.()) ?? { schedules: [], presets: [] };
    const extraIds = new Set(extra.schedules.map((s) => s.id));
    this.presetsInUse = [...book.presets.filter((p) => !extra.presets.some((e) => e.id === p.id)), ...extra.presets];
    return [...book.schedules.filter((s) => !extraIds.has(s.id)), ...extra.schedules];
  }

  /** Has the loop apply the definitions as they are now; settles once it has. */
  private async applied(): Promise<ScheduleList> {
    if (this.loop) await this.waker.wake();
    else await this.scheduler().adopt(await this.loadSpecs());
    return this.list();
  }

  list(): ScheduleList {
    if (!this.opened) return { available: false, ...(this.unavailable ? { reason: this.unavailable } : {}), schedules: [] };
    return { available: true, schedules: structuredClone(this.opened.scheduler.views()) };
  }

  history(scheduleId: string): HistoryEntry[] {
    return structuredClone([...this.scheduler().history(scheduleId)]);
  }

  async upsert(spec: ScheduleSpec): Promise<ScheduleList> {
    const { book } = this.owned();
    const preset = this.deps.presets.get(spec.presetId);
    if (!preset) throw new HttpError(422, 'unknown-preset', `Preset ${spec.presetId} does not exist`);
    if (splitProfileId(spec.profileId).siteId !== preset.siteId) {
      throw new HttpError(422, 'site-mismatch', `Profile ${spec.profileId} and preset ${spec.presetId} belong to different sites`);
    }
    try {
      validateTrigger(spec);
    } catch (err) {
      throw new HttpError(422, 'invalid-trigger', (err as Error).message);
    }
    await book.withSchedule(spec, runPresetOf(preset));
    return this.applied();
  }

  async remove(scheduleId: string): Promise<ScheduleList> {
    const { book, scheduler } = this.owned();
    if (!(await book.withoutSchedule(scheduleId))) throw new HttpError(404, 'unknown-schedule', `Unknown schedule ${scheduleId}`);
    await scheduler.remove(scheduleId);
    return this.applied();
  }

  private known(scheduleId: string): void {
    if (!this.scheduler().views().some((v) => v.spec.id === scheduleId)) throw new HttpError(404, 'unknown-schedule', `Unknown schedule ${scheduleId}`);
  }

  async trigger(scheduleId: string, cause: TriggerCause = 'manual'): Promise<string> {
    this.known(scheduleId);
    try {
      return await this.scheduler().trigger(scheduleId, cause);
    } catch (err) {
      if (err instanceof ScheduleSkipped) throw new HttpError(409, `skipped-${err.reason}`, err.message);
      throw err;
    } finally {
      this.publish();
    }
  }

  /** Runs that come due while paused are skipped; resuming only affects runs still ahead. */
  async control(scheduleId: string, op: 'pause' | 'resume'): Promise<ScheduleList> {
    this.known(scheduleId);
    await this.scheduler()[op](scheduleId);
    this.publish();
    return this.list();
  }

  /** A saved UI preset replaces the copy the schedules run, so runs planned from now on use it. */
  async presetSaved(preset: StoredPreset): Promise<void> {
    if (!this.opened) return;
    if (await this.opened.book.replacePreset(runPresetOf(preset))) await this.applied();
  }

  /** The schedules that run this preset. */
  async usersOf(presetId: string): Promise<string[]> {
    if (!this.opened) return [];
    return (await this.opened.book.load()).schedules.filter((s) => s.presetId === presetId).map((s) => s.id);
  }
}
