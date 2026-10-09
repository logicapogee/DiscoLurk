import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, type RunPreset, type ScheduleSpec } from '@disco-lurk/core';
import { PlanScheduler, validateTrigger, type SchedulerDeps, type SchedulerState, type ScheduleStore } from '@disco-lurk/scheduler';
import { z } from 'zod';
import { ConfigFileError, JsonFile, readJson } from './json-file';
import { currentLockOwner, lockOwnerLive, markLockHeld, markLockReleased, type LivenessProbe, type LockOwner } from './process';
import { experimentsSchema, extraWaitSchema, interactionSchema, runPresetSchema, sampleSchema, scheduleSpecSchema } from './schemas';
import { categorySchema } from './site';

const bookSchema = z
  .object({
    schemaVersion: z.literal(1),
    schedules: z.array(scheduleSpecSchema),
    presets: z.array(runPresetSchema),
  })
  .strict();

/** The user's schedule definitions and the presets they run. */
export interface ScheduleBook {
  schedules: ScheduleSpec[];
  presets: RunPreset[];
}

function checkBook(path: string, book: ScheduleBook): void {
  const dup = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i);
  const dupSchedule = dup(book.schedules.map((s) => s.id));
  if (dupSchedule) throw new ConfigFileError(path, `schedule id ${dupSchedule} is used twice`);
  const dupPreset = dup(book.presets.map((p) => p.id));
  if (dupPreset) throw new ConfigFileError(path, `preset id ${dupPreset} is used twice`);
  for (const s of book.schedules) {
    const preset = book.presets.find((p) => p.id === s.presetId);
    if (!preset) throw new ConfigFileError(path, `schedule ${s.id} names preset ${s.presetId}, which does not exist`);
    if (preset.siteId !== s.profileId.split('/')[0]) {
      throw new ConfigFileError(path, `schedule ${s.id} runs Profile ${s.profileId} with preset ${preset.id} of site ${preset.siteId}`);
    }
    try {
      validateTrigger(s);
    } catch (err) {
      throw new ConfigFileError(path, `schedule ${s.id}: ${(err as Error).message}`);
    }
  }
}

/** `<dir>/schedules.json`: written by the CLI and the UI, re-read by the running scheduler. */
export class FileScheduleBook {
  private readonly file: JsonFile<typeof bookSchema>;
  private cached: { version: string; book: ScheduleBook } | null = null;

  constructor(readonly dir: string) {
    this.file = new JsonFile(join(dir, 'schedules.json'), bookSchema, 'schedule file');
  }

  get path(): string {
    return this.file.path;
  }

  /** Parses the file only when it changed since the last load, which the scheduler loop does every step. */
  async load(): Promise<ScheduleBook> {
    const version = await this.file.version();
    if (version === null) return { schedules: [], presets: [] };
    if (this.cached?.version === version) return structuredClone(this.cached.book);
    const data = await this.file.load();
    const book = (data ? { schedules: data.schedules, presets: data.presets } : { schedules: [], presets: [] }) as ScheduleBook;
    checkBook(this.path, book);
    this.cached = { version, book: structuredClone(book) };
    return book;
  }

  async save(book: ScheduleBook): Promise<void> {
    checkBook(this.path, book);
    await this.file.save({ schemaVersion: 1, ...book });
  }

  /** Adds or replaces a schedule together with the preset it runs. */
  async withSchedule(spec: ScheduleSpec, preset: RunPreset): Promise<ScheduleBook> {
    const current = await this.load();
    const book = {
      schedules: [...current.schedules.filter((s) => s.id !== spec.id), structuredClone(spec)],
      presets: [...current.presets.filter((p) => p.id !== preset.id), structuredClone(preset)],
    };
    await this.save(book);
    return book;
  }

  /** Removes a schedule and the preset copy no other schedule runs; null when there was no such schedule. */
  async withoutSchedule(scheduleId: string): Promise<ScheduleSpec | null> {
    const current = await this.load();
    const spec = current.schedules.find((s) => s.id === scheduleId);
    if (!spec) return null;
    const schedules = current.schedules.filter((s) => s.id !== scheduleId);
    const presets = current.presets.filter((p) => schedules.some((s) => s.presetId === p.id));
    await this.save({ schedules, presets });
    return spec;
  }

  /** Replaces the copy of a preset the schedules run; false when no schedule runs it. */
  async replacePreset(preset: RunPreset): Promise<boolean> {
    const current = await this.load();
    if (!current.presets.some((p) => p.id === preset.id)) return false;
    await this.save({ ...current, presets: current.presets.map((p) => (p.id === preset.id ? structuredClone(preset) : p)) });
    return true;
  }
}

const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO timestamp');

const snapshotSchema = z
  .object({
    id: z.string().min(1),
    scheduleId: z.string().optional(),
    siteId: z.string().min(1),
    profileId: z.string().min(1),
    browserMode: z.enum(['headed', 'headless']),
    preset: z
      .object({
        presetId: z.string(),
        browseMode: z.enum(['deep', 'quick']),
        runMode: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('endless') }).strict(),
          z.object({ kind: z.literal('topics'), count: z.number().int().min(1) }).strict(),
          z.object({ kind: z.literal('time'), minutes: z.number().positive() }).strict(),
        ]),
        categories: z.array(categorySchema),
        interaction: interactionSchema,
        extraWait: extraWaitSchema,
        samplePerCategory: sampleSchema,
        experiments: experimentsSchema.optional(),
      })
      .strict(),
    seed: z.number().int(),
    plannedAt: isoString,
    materializedAt: isoString,
  })
  .strict();

const historySchema = z
  .object({
    at: isoString,
    snapshotId: z.string(),
    cause: z.enum(['planned', 'run-on-start', 'misfire', 'manual']),
    outcome: z.enum(['started', 'skipped', 'missed']),
    reason: z.string().optional(),
    runId: z.string().optional(),
    ended: z
      .object({
        at: isoString,
        outcome: z.enum(['completed', 'failed', 'cancelled']),
        stopCause: z.enum(['target', 'user', 'app-exit', 'browser-closed', 'no-progress', 'error']),
        failure: z.enum(ERROR_CODES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    schedules: z.record(
      z.string(),
      z
        .object({
          paused: z.boolean(),
          runOnStartConsumed: z.boolean(),
          planKey: z.string().optional(),
          generatedDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
          planned: z.array(z.object({ snapshot: snapshotSchema, status: z.enum(['pending', 'started', 'skipped', 'missed']) }).strict()),
          history: z.array(historySchema),
        })
        .strict(),
    ),
  })
  .strict();

/** `<dir>/state.json`: materialized plans and run history, written only by the lock holder. */
export class FileScheduleStore implements ScheduleStore {
  private readonly file: JsonFile<typeof stateSchema>;

  constructor(readonly dir: string) {
    this.file = new JsonFile(join(dir, 'state.json'), stateSchema, 'scheduler state file');
  }

  get path(): string {
    return this.file.path;
  }

  async load(): Promise<SchedulerState | null> {
    return (await this.file.load()) as SchedulerState | null;
  }

  save(state: SchedulerState): Promise<void> {
    return this.file.save(state as z.input<typeof stateSchema>);
  }
}

interface SchedulerLock {
  release(): Promise<void>;
}

export class SchedulerLockedError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`The scheduler state in ${path} is owned by process ${pid} (a running lurk serve or schedule command)`);
    this.name = 'SchedulerLockedError';
  }
}

/**
 * One process at a time owns the scheduler state, since each holds it in memory and writes it
 * back whole. A lock whose owner is gone (see `lockOwnerLive`) is taken over.
 */
export async function acquireSchedulerLock(dir: string, probe: LivenessProbe = {}): Promise<SchedulerLock> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, '.lurk-lock');
  const info = { ...(await currentLockOwner()), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(info), { flag: 'wx' });
      markLockHeld(path);
      return {
        async release() {
          markLockReleased(path);
          const current = (await readJson(path).catch(() => null)) as { pid?: number; startedAt?: string } | null;
          if (current?.pid === info.pid && current.startedAt === info.startedAt) await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = (await readJson(path).catch(() => null)) as LockOwner | null;
      if (typeof holder?.pid === 'number' && (await lockOwnerLive(holder, path, probe))) throw new SchedulerLockedError(dir, holder.pid);
      await unlink(path).catch(() => {});
    }
  }
  throw new SchedulerLockedError(dir, -1);
}

interface OpenSchedulerOptions {
  /** `<appData>/disco-lurk`; definitions, state and the lock live in its `schedules` directory. */
  dataDir: string;
  deps: Omit<SchedulerDeps, 'store'>;
  probe?: LivenessProbe;
}

export interface OpenedScheduler {
  scheduler: PlanScheduler;
  book: FileScheduleBook;
  dir: string;
  /** Gives up the state lock; runs the scheduler started are the caller's to stop first. */
  close(): Promise<void>;
}

export const schedulesDirOf = (dataDir: string) => join(dataDir, 'schedules');

/**
 * The one way a process takes charge of the schedules: it owns the state lock, plans and fires
 * from `state.json`, and reads definitions from `schedules.json`. Throws `SchedulerLockedError`
 * while another process owns them.
 */
export async function openScheduler(opts: OpenSchedulerOptions): Promise<OpenedScheduler> {
  const dir = schedulesDirOf(opts.dataDir);
  const lock = await acquireSchedulerLock(dir, opts.probe);
  return {
    scheduler: new PlanScheduler({ ...opts.deps, store: new FileScheduleStore(dir) }),
    book: new FileScheduleBook(dir),
    dir,
    close: () => lock.release(),
  };
}
