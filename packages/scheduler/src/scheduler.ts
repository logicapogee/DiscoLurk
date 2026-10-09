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
  type RunResult,
  type ScheduleId,
  type ScheduleSpec,
  type ScheduleView,
  type Scheduler,
  type SiteId,
  type TriggerCause,
} from '@disco-lurk/core';
import { nextCronTime, parseCron } from './cron';
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

/** History entries kept per schedule; older ones are dropped on the next write. */
export const HISTORY_LIMIT = 200;
/** Finished planned runs and generated days older than this are dropped; history keeps their outcome. */
const PLAN_RETENTION_MS = 7 * 24 * 3_600_000;

const emptyScheduleState = (): ScheduleState => ({ paused: false, runOnStartConsumed: false, generatedDays: [], planned: [], history: [] });

const planKey = (spec: ScheduleSpec) => JSON.stringify([spec.timezone, spec.trigger]);

/** Rejects a trigger the scheduler could not plan, before anything is persisted for it. */
export function validateTrigger(spec: Pick<ScheduleSpec, 'trigger' | 'timezone'>): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: spec.timezone });
  } catch {
    throw new Error(`Unknown time zone "${spec.timezone}"; use an IANA name such as Asia/Shanghai`);
  }
  const t = spec.trigger;
  if (t.kind === 'cron') {
    parseCron(t.expression);
    return;
  }
  const start = parseHhmm(t.start);
  const end = parseHhmm(t.end);
  if (end <= start) throw new Error(`Window ${t.start}-${t.end} must end after it starts`);
  if (!Number.isInteger(t.runs) || t.runs < 1) throw new Error('runs per day must be a whole number of at least 1');
  if (t.jitterMinutes < 0 || t.minGapMinutes < 0) throw new Error('jitter and minimum gap cannot be negative');
}

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
    const now = this.deps.clock.now();
    for (const s of Object.values(this.state!.schedules)) {
      if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
      s.planned = s.planned.filter((p) => p.status === 'pending' || now - Date.parse(p.snapshot.plannedAt) < PLAN_RETENTION_MS);
      const oldest = new Date(now - PLAN_RETENTION_MS).toISOString().slice(0, 10);
      s.generatedDays = s.generatedDays.filter((d) => d >= oldest);
    }
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
    const siteId = this.deps.siteOf(spec.profileId);
    if (preset.siteId !== siteId) throw new Error(`Schedule ${spec.id} runs Profile ${spec.profileId} of site ${siteId} with preset ${preset.id} of site ${preset.siteId}`);
    return {
      id: this.deps.newId(),
      scheduleId: spec.id,
      siteId,
      profileId: spec.profileId,
      browserMode: spec.browserMode,
      preset: resolvePreset(preset, categories, seededRandom(seed), (code, message) => this.deps.warn?.(code, `Schedule ${spec.id}: ${message}`)),
      seed,
      plannedAt: this.iso(plannedAtMs),
      materializedAt: this.iso(),
    };
  }

  /**
   * Keeps the plan ahead filled: the current local day for a daily window, the next occurrence
   * for cron. Existing pending runs are kept as materialized, so restarts read the same plan.
   */
  private plan(spec: ScheduleSpec, s: ScheduleState): void {
    const key = planKey(spec);
    if (s.planKey !== undefined && s.planKey !== key) {
      s.planned = s.planned.filter((p) => p.status !== 'pending');
      s.generatedDays = [];
    }
    s.planKey = key;
    const now = this.deps.clock.now();
    const t = spec.trigger;
    if (t.kind === 'cron') {
      if (s.planned.some((p) => p.status === 'pending')) return;
      const last = s.planned.reduce((max, p) => Math.max(max, Date.parse(p.snapshot.plannedAt)), -Infinity);
      const at = nextCronTime(parseCron(t.expression), Math.max(now, last), spec.timezone);
      if (at !== null) s.planned.push({ snapshot: this.materialize(spec, at), status: 'pending' });
      return;
    }
    const today = localParts(now, spec.timezone);
    if (s.generatedDays.includes(today.date)) return;
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

  /** A run that could not start is settled as skipped, so the next tick does not retry it. */
  private tryFire(spec: ScheduleSpec, s: ScheduleState, entry: PlannedRun, cause: TriggerCause): void {
    try {
      this.fire(spec, s, entry.snapshot, cause);
      entry.status = 'started';
    } catch (err) {
      entry.status = 'skipped';
      if (err instanceof ScheduleSkipped) return;
      this.record(s, { snapshotId: entry.snapshot.id, cause, outcome: 'skipped', reason: 'start-failed' });
      throw err;
    }
  }

  /** Takes the current definitions without planning or firing anything. */
  async adopt(specs: ScheduleSpec[]): Promise<void> {
    await this.load();
    for (const spec of specs) validateTrigger(spec);
    this.specs = new Map(specs.map((s) => [s.id, s]));
  }

  async reconcile(specs: ScheduleSpec[]): Promise<ScheduleView[]> {
    const state = await this.load();
    await this.adopt(specs);
    for (const spec of specs) {
      const s = (state.schedules[spec.id] ??= emptyScheduleState());
      if (spec.enabled) this.plan(spec, s);
    }
    await this.persist();
    // Run-on-start still fires when one schedule's tick fails; the failure is reported afterwards.
    const ticked = await this.tick().then(
      () => null,
      (err: unknown) => err,
    );
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
    if (ticked) throw ticked;
    return this.views();
  }

  /** Starts every due run; late runs past the grace period follow the misfire policy. */
  async tick(): Promise<void> {
    const state = await this.load();
    const now = this.deps.clock.now();
    const failures: string[] = [];
    for (const spec of this.specs.values()) {
      const s = state.schedules[spec.id];
      if (!s || !spec.enabled) continue;
      try {
        this.tickOne(spec, s, now);
      } catch (err) {
        failures.push(`schedule ${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.persist();
    if (failures.length > 0) throw new Error(failures.join('; '));
  }

  /** One schedule's step; one schedule failing leaves the others' runs to fire. */
  private tickOne(spec: ScheduleSpec, s: ScheduleState, now: number): void {
    this.plan(spec, s);
    const due = s.planned.filter((p) => p.status === 'pending' && Date.parse(p.snapshot.plannedAt) <= now);
    const graceMs = spec.misfire.graceMinutes * 60_000;
    const missed = due.filter((p) => now - Date.parse(p.snapshot.plannedAt) > graceMs);
    for (const p of due.filter((p) => !missed.includes(p))) this.tryFire(spec, s, p, 'planned');
    for (const p of missed) {
      p.status = 'missed';
      this.record(s, { snapshotId: p.snapshot.id, cause: 'misfire', outcome: 'missed' });
    }
    if (missed.length > 0 && spec.misfire.policy === 'run-once') this.tryFire(spec, s, missed.at(-1)!, 'misfire');
    // A cron schedule holds one pending run, so the next one is planned once this one is settled.
    this.plan(spec, s);
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
    await this.setPaused(scheduleId, true);
  }

  /** Runs that came due while paused were skipped; resuming only affects runs still ahead. */
  async resume(scheduleId: ScheduleId): Promise<void> {
    await this.setPaused(scheduleId, false);
  }

  private async setPaused(scheduleId: ScheduleId, paused: boolean): Promise<void> {
    const state = await this.load();
    (state.schedules[scheduleId] ??= emptyScheduleState()).paused = paused;
    await this.persist();
  }

  /** Forgets a deleted schedule's plan and history. */
  async remove(scheduleId: ScheduleId): Promise<void> {
    const state = await this.load();
    delete state.schedules[scheduleId];
    this.specs.delete(scheduleId);
    await this.persist();
  }

  /** Records how a run this scheduler started ended. */
  async finish(runId: RunId, result: Pick<RunResult, 'outcome' | 'stopCause' | 'failure'>): Promise<void> {
    const state = await this.load();
    for (const s of Object.values(state.schedules)) {
      const entry = s.history.find((e) => e.runId === runId);
      if (!entry) continue;
      entry.ended = {
        at: this.iso(),
        outcome: result.outcome,
        stopCause: result.stopCause,
        ...(result.failure ? { failure: result.failure.code } : {}),
      };
      await this.persist();
      return;
    }
  }

  history(scheduleId: ScheduleId): readonly HistoryEntry[] {
    return this.state?.schedules[scheduleId]?.history ?? [];
  }

  views(): ScheduleView[] {
    const now = this.deps.clock.now();
    return [...this.specs.values()].map((spec) => {
      const s = this.state?.schedules[spec.id];
      const next = s?.planned
        .filter((p) => p.status === 'pending' && Date.parse(p.snapshot.plannedAt) > now)
        .sort((a, b) => Date.parse(a.snapshot.plannedAt) - Date.parse(b.snapshot.plannedAt))[0];
      return { spec, paused: s?.paused ?? false, next: next ? structuredClone(next.snapshot) : null };
    });
  }
}
