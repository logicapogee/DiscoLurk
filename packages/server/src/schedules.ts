import { systemRandom, type Clock, type RandomSource, type RunPreset, type ScheduleSpec, type ScheduleView, type TriggerCause } from '@disco-lurk/core';
import { MemoryScheduleStore, PlanScheduler, ScheduleSkipped, type ScheduleStore } from '@disco-lurk/scheduler';
import type { ProfileGate, RunManager, SiteCatalog } from './runs';
import { HttpError } from './server';
import { splitProfileId, type PresetStore } from './store';

export const SCHEDULE_TICK_MS = 30_000;

export interface ScheduleServiceDeps {
  clock: Clock;
  random?: RandomSource;
  store?: ScheduleStore;
  presets: PresetStore;
  catalog: SiteCatalog;
  runs: RunManager;
  gate: ProfileGate;
  displayAvailable(): boolean;
  log(message: string): void;
}

/**
 * The schedule endpoints over the kernel's PlanScheduler. Specs are held in memory and the
 * scheduler state in a MemoryScheduleStore, so both are lost on restart until they are persisted
 * to disk.
 */
export class ScheduleService {
  private specs = new Map<string, ScheduleSpec>();
  private readonly scheduler: PlanScheduler;
  private timer: NodeJS.Timeout | null = null;
  private views: ScheduleView[] = [];

  constructor(private readonly deps: ScheduleServiceDeps) {
    let seq = 0;
    this.scheduler = new PlanScheduler({
      clock: deps.clock,
      random: deps.random ?? systemRandom,
      store: deps.store ?? new MemoryScheduleStore(),
      newId: () => `run-${deps.clock.now()}-s${(seq++).toString(36)}`,
      loadPreset: (presetId) => {
        const preset = deps.presets.get(presetId);
        if (!preset) throw new Error(`Preset ${presetId} no longer exists`);
        return { preset: preset satisfies RunPreset, categories: deps.catalog.categories(preset.siteId) };
      },
      siteOf: (profileId) => splitProfileId(profileId).siteId,
      profileBusy: (profileId) => deps.gate.isBusy(profileId),
      displayAvailable: deps.displayAvailable,
      startRun: (plan) => deps.runs.launch(plan, deps.presets.get(plan.preset.presetId)?.name ?? plan.preset.presetId).runId,
    });
  }

  start(intervalMs = SCHEDULE_TICK_MS): void {
    this.timer = setInterval(() => {
      this.reconcile().catch((err: unknown) => this.deps.log(`schedule tick failed: ${String(err)}`));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async reconcile(): Promise<ScheduleView[]> {
    this.views = await this.scheduler.reconcile([...this.specs.values()]);
    return this.views;
  }

  list(): ScheduleView[] {
    return structuredClone(this.views);
  }

  history(scheduleId: string) {
    return this.scheduler.history(scheduleId);
  }

  async upsert(spec: ScheduleSpec): Promise<ScheduleView[]> {
    if (spec.trigger.kind === 'cron') throw new HttpError(422, 'cron-unsupported', 'Cron triggers are not supported by this build; use a daily window');
    const preset = this.deps.presets.get(spec.presetId);
    if (!preset) throw new HttpError(422, 'unknown-preset', `Preset ${spec.presetId} does not exist`);
    if (splitProfileId(spec.profileId).siteId !== preset.siteId) {
      throw new HttpError(422, 'site-mismatch', `Profile ${spec.profileId} and preset ${spec.presetId} belong to different sites`);
    }
    try {
      Intl.DateTimeFormat('en-US', { timeZone: spec.timezone });
    } catch {
      throw new HttpError(422, 'invalid-timezone', `Unknown time zone ${spec.timezone}`);
    }
    this.specs.set(spec.id, structuredClone(spec));
    return this.reconcile();
  }

  async remove(scheduleId: string): Promise<ScheduleView[]> {
    if (!this.specs.delete(scheduleId)) throw new HttpError(404, 'unknown-schedule', `Unknown schedule ${scheduleId}`);
    return this.reconcile();
  }

  async trigger(scheduleId: string, cause: TriggerCause = 'manual'): Promise<string> {
    if (!this.specs.has(scheduleId)) throw new HttpError(404, 'unknown-schedule', `Unknown schedule ${scheduleId}`);
    try {
      return await this.scheduler.trigger(scheduleId, cause);
    } catch (err) {
      if (err instanceof ScheduleSkipped) throw new HttpError(409, `skipped-${err.reason}`, err.message);
      throw err;
    }
  }

  async pause(scheduleId: string): Promise<ScheduleView[]> {
    if (!this.specs.has(scheduleId)) throw new HttpError(404, 'unknown-schedule', `Unknown schedule ${scheduleId}`);
    await this.scheduler.pause(scheduleId);
    return this.reconcile();
  }
}
