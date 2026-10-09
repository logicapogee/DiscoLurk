import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, type RunPreset, type ScheduleSpec } from '@disco-lurk/core';
import { PlanScheduler, validateTrigger, type SchedulerDeps, type SchedulerState, type ScheduleStore } from '@disco-lurk/scheduler';
import { z } from 'zod';
import { writeJsonAtomic } from './category-store';
import { categorySchema } from './site';

/** A schedule or preset file that exists but cannot be used; the message names the file. */
export class ConfigFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}; fix or delete the file`);
    this.name = 'ConfigFileError';
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** The parsed file, or null when it does not exist. */
async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigFileError(path, `not valid JSON (${(err as Error).message})`);
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const percent = z.number().min(0).max(100);

const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expression: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('daily-window'),
      runs: z.number().int().min(1),
      start: hhmm,
      end: hhmm,
      jitterMinutes: z.number().min(0),
      minGapMinutes: z.number().min(0),
    })
    .strict(),
]);

export const scheduleSpecSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    name: z.string().min(1),
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/),
    presetId: z.string().min(1),
    enabled: z.boolean(),
    browserMode: z.enum(['headed', 'headless']),
    timezone: z.string().min(1),
    trigger: triggerSchema,
    misfire: z.object({ policy: z.enum(['skip', 'run-once']), graceMinutes: z.number().min(0) }).strict(),
    overlap: z.literal('skip'),
    unavailableDisplay: z.enum(['skip', 'fallback-headless']),
    runOnStart: z.boolean(),
  })
  .strict();

const interactionSchema = z
  .object({
    like: z.object({ enabled: z.boolean(), topicRate: percent, replyRate: percent, maxReplies: z.number().int().min(0) }).strict(),
    reply: z.object({ enabled: z.boolean(), rate: percent, riskAcknowledged: z.boolean() }).strict(),
  })
  .strict();

const extraWaitSchema = z.object({ enabled: z.boolean(), minSec: z.number().min(0), maxSec: z.number().min(0) }).strict();
const sampleSchema = z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict();
const experimentsSchema = z
  .object({ useNewList: z.boolean(), useUnreadList: z.boolean(), refreshCategories: z.boolean(), smartRanked: z.boolean() })
  .strict();

export const runPresetSchema = z
  .object({
    id: z.string().min(1),
    siteId: z.string().min(1),
    browseMode: z.enum(['deep', 'quick']),
    runMode: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('endless') }).strict(),
      z.object({ kind: z.literal('topics'), min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
      z.object({ kind: z.literal('time'), minutes: z.number().positive() }).strict(),
    ]),
    categoryPaths: z.array(z.string()),
    interaction: interactionSchema,
    extraWait: extraWaitSchema,
    samplePerCategory: sampleSchema,
    experiments: experimentsSchema.optional(),
  })
  .strict();

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
  for (const p of book.presets) {
    if (p.runMode.kind === 'topics' && p.runMode.max < p.runMode.min) throw new ConfigFileError(path, `preset ${p.id}: topic range ends below its start`);
    if (p.extraWait.maxSec < p.extraWait.minSec || p.samplePerCategory.max < p.samplePerCategory.min) {
      throw new ConfigFileError(path, `preset ${p.id}: a range ends below its start`);
    }
  }
}

/** `<dir>/schedules.json`: written by the CLI and the UI, re-read by the running scheduler. */
export class FileScheduleBook {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, 'schedules.json');
  }

  async load(): Promise<ScheduleBook> {
    const json = await readJson(this.path);
    if (json === null) return { schedules: [], presets: [] };
    const parsed = bookSchema.safeParse(json);
    if (!parsed.success) throw new ConfigFileError(this.path, `not a valid schedule file (${issuesOf(parsed.error)})`);
    const book = { schedules: parsed.data.schedules, presets: parsed.data.presets } as unknown as ScheduleBook;
    checkBook(this.path, book);
    return book;
  }

  async save(book: ScheduleBook): Promise<void> {
    checkBook(this.path, book);
    await writeJsonAtomic(this.path, { schemaVersion: 1, ...structuredClone(book) });
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
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, 'state.json');
  }

  async load(): Promise<SchedulerState | null> {
    const json = await readJson(this.path);
    if (json === null) return null;
    const parsed = stateSchema.safeParse(json);
    if (!parsed.success) throw new ConfigFileError(this.path, `not a valid scheduler state file (${issuesOf(parsed.error)})`);
    return parsed.data as unknown as SchedulerState;
  }

  /** Writes run one after another, in call order, so an older state never lands last. */
  save(state: SchedulerState): Promise<void> {
    const value = structuredClone(state);
    const write = this.writes.catch(() => {}).then(() => writeJsonAtomic(this.path, value));
    this.writes = write;
    return write;
  }
}

export interface SchedulerLock {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One process at a time owns the scheduler state, since each holds it in memory and writes it
 * back whole. A lock left by a process that no longer exists is taken over.
 */
export async function acquireSchedulerLock(dir: string, isAlive: (pid: number) => boolean = alive): Promise<SchedulerLock> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, '.lurk-lock');
  const info = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(info), { flag: 'wx' });
      return {
        async release() {
          const current = (await readJson(path).catch(() => null)) as { pid?: number; startedAt?: string } | null;
          if (current?.pid === info.pid && current.startedAt === info.startedAt) await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = (await readJson(path).catch(() => null)) as { pid?: number } | null;
      if (typeof holder?.pid === 'number' && isAlive(holder.pid)) throw new SchedulerLockedError(dir, holder.pid);
      await unlink(path).catch(() => {});
    }
  }
  throw new SchedulerLockedError(dir, -1);
}

export interface OpenSchedulerOptions {
  /** `<appData>/disco-lurk`; definitions, state and the lock live in its `schedules` directory. */
  dataDir: string;
  deps: Omit<SchedulerDeps, 'store'>;
  isAlive?: (pid: number) => boolean;
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
  const lock = await acquireSchedulerLock(dir, opts.isAlive);
  return {
    scheduler: new PlanScheduler({ ...opts.deps, store: new FileScheduleStore(dir) }),
    book: new FileScheduleBook(dir),
    dir,
    close: () => lock.release(),
  };
}
