import {
  resolvePreset,
  seededRandom,
  type Category,
  type Clock,
  type ProfileId,
  type RandomSource,
  type RunId,
  type RunPlanSnapshot,
  type RunPreset,
  type ScheduleId,
  type ScheduleSpec,
  type ScheduleView,
  type Scheduler,
  type SiteId,
  type TriggerCause,
} from '@disco-lurk/core';
import { dailyPoints, type DailyWindow } from './daily';
import type { HistoryEntry, PlannedRun, ScheduleState, SchedulerState, ScheduleStore } from './store';
import { localParts, parseHhmm, zonedToEpoch } from './tz';

export interface SchedulerDeps {
  clock: Clock;
  random: RandomSource;
  store: ScheduleStore;
  newId(): string;
  loadPreset(presetId: string): { preset: RunPreset; categories: Category[] };
  siteOf(profileId: ProfileId): SiteId;
  /** Runs are exclusive per Profile, not per site. */
  profileBusy(profileId: ProfileId): boolean;
  /** False when there is no graphical session for a headed browser (locked screen, logged out, SSH). */
  displayAvailable(): boolean;
  startRun(plan: RunPlanSnapshot, cause: TriggerCause): RunId;
  /** Where a preset setting the run cannot honour is reported, e.g. replies without their risk acknowledged. */
  warn?(code: string, message: string): void;
}

export type SkipReason = 'paused' | 'disabled' | 'overlap' | 'no-display';

export class ScheduleSkipped extends Error {
  constructor(
    readonly scheduleId: ScheduleId,
    readonly reason: SkipReason,
  ) {
    super(`Schedule ${scheduleId} skipped: ${reason}`);
    this.name = 'ScheduleSkipped';
  }
}

const emptyScheduleState = (): ScheduleState => ({ paused: false, runOnStartConsumed: false, generatedDays: [], planned: [], history: [] });

/** Materializes runs into immutable snapshots up front and persists them before anything fires. */
export class PlanScheduler implements Scheduler {
  private specs = new Map<ScheduleId, ScheduleSpec>();
  private state: SchedulerState | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  private async load(): Promise<SchedulerState> {
    this.state ??= (await this.deps.store.load()) ?? { schemaVersion: 1, schedules: {} };
    return this.state;
  }

  private persist(): Promise<void> {
    return this.deps.store.save(structuredClone(this.state!));
  }

  private iso(ms = this.deps.clock.now()): string {
    return new Date(ms).toISOString();
  }

  private record(s: ScheduleState, entry: Omit<HistoryEntry, 'at'>): void {
    s.history.push({ at: this.iso(), ...entry });
  }

  private materialize(spec: ScheduleSpec, plannedAtMs: number): RunPlanSnapshot {
    const seed = Math.floor(this.deps.random.next() * 0x1_0000_0000);
    const { preset, categories } = this.deps.loadPreset(spec.presetId);
    return {
      id: this.deps.newId(),
      scheduleId: spec.id,
      siteId: this.deps.siteOf(spec.profileId),
      profileId: spec.profileId,
      browserMode: spec.browserMode,
      preset: resolvePreset(preset, categories, seededRandom(seed), (code, message) => this.deps.warn?.(code, `Schedule ${spec.id}: ${message}`)),
      seed,
      plannedAt: this.iso(plannedAtMs),
      materializedAt: this.iso(),
    };
  }

  /** Generates the current local day once; later reconciles and restarts read the stored plan. */
  private planToday(spec: ScheduleSpec, s: ScheduleState): void {
    if (spec.trigger.kind !== 'daily-window') {
      throw new Error(`Schedule ${spec.id}: trigger kind "${spec.trigger.kind}" is not supported by this build`);
    }
    const now = this.deps.clock.now();
    const today = localParts(now, spec.timezone);
    if (s.generatedDays.includes(today.date)) return;
    const t = spec.trigger;
    const window: DailyWindow = {
      runs: t.runs,
      start: parseHhmm(t.start),
      end: parseHhmm(t.end),
      jitterMinutes: t.jitterMinutes,
      minGapMinutes: t.minGapMinutes,
    };
    for (const minute of dailyPoints(window, today.minutes + 1, this.deps.random)) {
      s.planned.push({ snapshot: this.materialize(spec, zonedToEpoch(today.date, minute, spec.timezone)), status: 'pending' });
    }
    s.generatedDays.push(today.date);
  }

  private fire(spec: ScheduleSpec, s: ScheduleState, plan: RunPlanSnapshot, cause: TriggerCause): RunId {
    const skip = (reason: SkipReason): never => {
      this.record(s, { snapshotId: plan.id, cause, outcome: 'skipped', reason });
      throw new ScheduleSkipped(spec.id, reason);
    };
    if (!spec.enabled) skip('disabled');
    if (s.paused) skip('paused');
    // Queueing would merge two runs into one long session and break the random-day semantics.
    if (this.deps.profileBusy(spec.profileId)) skip('overlap');
    let run = plan;
    if (plan.browserMode === 'headed' && !this.deps.displayAvailable()) {
      if (spec.unavailableDisplay === 'skip') skip('no-display');
      run = { ...plan, browserMode: 'headless' };
    }
    const runId = this.deps.startRun(run, cause);
    this.record(s, {
      snapshotId: plan.id,
      cause,
      outcome: 'started',
      runId,
      ...(run !== plan ? { reason: 'fallback-headless' } : {}),
    });
    return runId;
  }

  private tryFire(spec: ScheduleSpec, s: ScheduleState, entry: PlannedRun, cause: TriggerCause): void {
    try {
      this.fire(spec, s, entry.snapshot, cause);
      entry.status = 'started';
    } catch (err) {
      if (!(err instanceof ScheduleSkipped)) throw err;
      entry.status = 'skipped';
    }
  }

  async reconcile(specs: ScheduleSpec[]): Promise<ScheduleView[]> {
    const state = await this.load();
    this.specs = new Map(specs.map((s) => [s.id, s]));
    for (const spec of specs) {
      const s = (state.schedules[spec.id] ??= emptyScheduleState());
      if (spec.enabled) this.planToday(spec, s);
    }
    await this.persist();
    await this.tick();
    for (const spec of specs) {
      const s = state.schedules[spec.id]!;
      if (spec.enabled && spec.runOnStart && !s.runOnStartConsumed) {
        // Consumed before firing: a crash or skip must not turn every restart into another start-up run.
        s.runOnStartConsumed = true;
        await this.persist();
        try {
          this.fire(spec, s, this.materialize(spec, this.deps.clock.now()), 'run-on-start');
        } catch (err) {
          if (!(err instanceof ScheduleSkipped)) throw err;
        }
      }
    }
    await this.persist();
    return this.views();
  }

  /** Starts every due run; late runs past the grace period follow the misfire policy. */
  async tick(): Promise<void> {
    const state = await this.load();
    const now = this.deps.clock.now();
    for (const spec of this.specs.values()) {
      const s = state.schedules[spec.id];
      if (!s || !spec.enabled) continue;
      this.planToday(spec, s);
      const due = s.planned.filter((p) => p.status === 'pending' && Date.parse(p.snapshot.plannedAt) <= now);
      const graceMs = spec.misfire.graceMinutes * 60_000;
      const missed = due.filter((p) => now - Date.parse(p.snapshot.plannedAt) > graceMs);
      for (const p of due.filter((p) => !missed.includes(p))) this.tryFire(spec, s, p, 'planned');
      if (missed.length === 0) continue;
      for (const p of missed) {
        p.status = 'missed';
        this.record(s, { snapshotId: p.snapshot.id, cause: 'misfire', outcome: 'missed' });
      }
      if (spec.misfire.policy === 'run-once') this.tryFire(spec, s, missed.at(-1)!, 'misfire');
    }
    await this.persist();
  }

  async trigger(scheduleId: ScheduleId, cause: TriggerCause): Promise<RunId> {
    const state = await this.load();
    const spec = this.specs.get(scheduleId);
    if (!spec) throw new Error(`Unknown schedule ${scheduleId}`);
    const s = (state.schedules[scheduleId] ??= emptyScheduleState());
    try {
      return this.fire(spec, s, this.materialize(spec, this.deps.clock.now()), cause);
    } finally {
      await this.persist();
    }
  }

  async pause(scheduleId: ScheduleId): Promise<void> {
    const state = await this.load();
    (state.schedules[scheduleId] ??= emptyScheduleState()).paused = true;
    await this.persist();
  }

  history(scheduleId: ScheduleId): readonly HistoryEntry[] {
    return this.state?.schedules[scheduleId]?.history ?? [];
  }

  private views(): ScheduleView[] {
    const now = this.deps.clock.now();
    return [...this.specs.values()].map((spec) => {
      const s = this.state!.schedules[spec.id]!;
      const next = s.planned
        .filter((p) => p.status === 'pending' && Date.parse(p.snapshot.plannedAt) > now)
        .sort((a, b) => Date.parse(a.snapshot.plannedAt) - Date.parse(b.snapshot.plannedAt))[0];
      return { spec, paused: s.paused, next: next ? structuredClone(next.snapshot) : null };
    });
  }
}
