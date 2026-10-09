import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DiscoLurkCoordinator,
  seededRandom,
  stopRequest,
  systemClock,
  type Category,
  type RunEvent,
  type RunId,
  type RunPlanSnapshot,
  type RunPreset,
  type RunResult,
  type ScheduleSpec,
  type SiteId,
} from '@disco-lurk/core';
import { acquireSchedulerLock, FileCategoryStore, FileScheduleBook, FileScheduleStore, SchedulerLockedError, type ScheduleBook } from '@disco-lurk/config';
import { PlanScheduler, ScheduleSkipped, type HistoryEntry, type ScheduleState, type SchedulerState } from '@disco-lurk/scheduler';
import { EnvError, proxyFromEnv } from './env';
import { appDataDir, sitesDir } from './paths';
import {
  cliEnv,
  createReporter,
  credentialsFromEnv,
  EXIT,
  exitCodeFor,
  parseProfileId,
  parseRunArgs,
  resolveCategories,
  siteCategories,
  UsageError,
} from './run';
import { findSite } from './sites';

export const schedulesDir = (base = appDataDir()) => join(base, 'schedules');

export const SCHEDULE_USAGE = `  lurk schedule list [--json]
  lurk schedule add --name <name> [--id <id>] --site <id> [--profile <name>]
           (--cron "<min hour dom month dow>" | --runs <n> --window <HH:MM-HH:MM> [--jitter <min>] [--min-gap <min>])
           [--timezone <IANA>] [--headed|--headless] [--fallback-headless] [--misfire skip|run-once] [--grace <min>]
           [--run-on-start] [--disabled] [lurk run options: --browse-mode --run-mode --categories --like … ]
  lurk schedule remove|pause|resume <id>
  lurk schedule run-now <id> [--json]`;

/** Sites whose category lists the scheduler resolves presets against; refreshed before each step. */
export class CategoryCache {
  private bySite = new Map<SiteId, Category[]>();

  async refresh(siteIds: Iterable<SiteId>): Promise<void> {
    const store = new FileCategoryStore(sitesDir());
    for (const id of new Set(siteIds)) {
      const site = findSite(id);
      if (site) this.bySite.set(id, await siteCategories(site, store));
    }
  }

  /** The preset's categories; a path the site's list does not know yet still counts, as on the command line. */
  resolve(preset: RunPreset): Category[] {
    const site = findSite(preset.siteId);
    if (!site) throw new Error(`Preset ${preset.id} names unknown site ${preset.siteId}`);
    return resolveCategories(site, this.bySite.get(site.id) ?? [], preset.categoryPaths);
  }

  known(siteId: SiteId): Category[] {
    return this.bySite.get(siteId) ?? [];
  }
}

export interface HostOptions {
  /** False when headed browsers cannot be shown, e.g. a container or `serve --headless`. */
  displayAvailable(): boolean;
  presets(): RunPreset[];
  categories: CategoryCache;
  emit(event: RunEvent, runId: RunId): void;
  log(message: string): void;
}

interface ActiveRun {
  profileId: string;
  stop: AbortController;
  done: Promise<RunResult | null>;
}

/** Owns the scheduler state lock and runs what the scheduler starts, one run per Profile. */
export class SchedulerHost {
  readonly scheduler: PlanScheduler;
  private readonly runs = new Map<RunId, ActiveRun>();
  private readonly exit = new AbortController();

  private constructor(
    private readonly opts: HostOptions,
    private readonly lock: { release(): Promise<void> },
    store: FileScheduleStore,
  ) {
    const credentialsEnv = (siteId: SiteId) => {
      const site = findSite(siteId);
      return site ? credentialsFromEnv(site) : undefined;
    };
    const proxy = proxyFromEnv(process.env);
    this.scheduler = new PlanScheduler({
      clock: systemClock,
      random: seededRandom(randomBytes(4).readUInt32LE()),
      store,
      newId: () => `plan-${randomUUID()}`,
      loadPreset: (presetId) => {
        const preset = opts.presets().find((p) => p.id === presetId);
        if (!preset) throw new Error(`Preset ${presetId} does not exist`);
        return { preset, categories: opts.categories.resolve(preset) };
      },
      siteOf: (profileId) => parseProfileId(profileId).siteId,
      profileBusy: (profileId) => [...this.runs.values()].some((r) => r.profileId === profileId),
      displayAvailable: () => opts.displayAvailable(),
      startRun: (plan, cause) => {
        const runId = `run-${randomUUID()}`;
        const credentials = credentialsEnv(plan.siteId);
        const env = cliEnv({ channel: 'chrome', exitSignal: this.exit.signal, ...(credentials ? { credentials } : {}), ...(proxy ? { proxy } : {}) });
        const stop = new AbortController();
        opts.log(`run ${runId} (${cause}) for ${plan.profileId}: ${plan.preset.browseMode}, ${JSON.stringify(plan.preset.runMode)}`);
        const done = new DiscoLurkCoordinator(env)
          .run(plan, stop.signal, (e) => opts.emit(e, runId))
          .then(async (result) => {
            const c = result.stats.confirmed;
            opts.log(`run ${runId} ended: ${result.outcome} (${result.stopCause})${result.failure ? ` ${result.failure.code}` : ''}, confirmed ${c.topics} topics / ${c.floors} floors`);
            await this.scheduler.finish(runId, result);
            return result;
          })
          .catch((err: unknown) => {
            opts.log(`run ${runId} crashed: ${(err as Error).stack ?? String(err)}`);
            return null;
          })
          .finally(() => this.runs.delete(runId));
        this.runs.set(runId, { profileId: plan.profileId, stop, done });
        return runId;
      },
    });
  }

  static async open(dir: string, opts: HostOptions): Promise<SchedulerHost> {
    let lock;
    try {
      lock = await acquireSchedulerLock(dir);
    } catch (err) {
      if (err instanceof SchedulerLockedError) {
        throw new EnvError(`${err.message}. Change schedules there, or stop it first.`);
      }
      throw err;
    }
    return new SchedulerHost(opts, lock, new FileScheduleStore(dir));
  }

  /** The run's result once it ends; null if it crashed or is unknown. */
  wait(runId: RunId): Promise<RunResult | null> {
    return this.runs.get(runId)?.done ?? Promise.resolve(null);
  }

  stopAll(reason: 'user' | 'app-exit'): void {
    for (const r of this.runs.values()) r.stop.abort(stopRequest(reason));
  }

  /** Stops every run, waits for each to record its ending, then gives up the state lock. */
  async close(): Promise<void> {
    this.stopAll('app-exit');
    this.exit.abort();
    await Promise.all([...this.runs.values()].map((r) => r.done));
    await this.lock.release();
  }
}

const SCHEDULE_VALUE_FLAGS = ['name', 'id', 'cron', 'runs', 'window', 'jitter', 'min-gap', 'timezone', 'misfire', 'grace'] as const;
const SCHEDULE_BOOL_FLAGS = ['fallback-headless', 'run-on-start', 'disabled'] as const;
type ScheduleFlags = Partial<Record<(typeof SCHEDULE_VALUE_FLAGS)[number], string>> & Partial<Record<(typeof SCHEDULE_BOOL_FLAGS)[number], true>>;

/** Splits `schedule add`'s own options from the `lurk run` options that describe its preset. */
export function splitAddArgs(argv: readonly string[]): { flags: ScheduleFlags; runArgv: string[] } {
  const flags: Record<string, string | true> = {};
  const runArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    const name = m?.[1];
    if (name && (SCHEDULE_VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = m[2] ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else if (name && (SCHEDULE_BOOL_FLAGS as readonly string[]).includes(name)) {
      flags[name] = true;
    } else {
      runArgv.push(arg);
    }
  }
  return { flags: flags as ScheduleFlags, runArgv };
}

function minutesFlag(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} must be a whole number of minutes`);
  return Number(raw);
}

export const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A schedule and its own preset from `lurk schedule add` arguments. */
export function buildScheduleFromArgs(argv: readonly string[], known: (siteId: SiteId) => Category[], newId: () => string): { spec: ScheduleSpec; preset: RunPreset } {
  const { flags, runArgv } = splitAddArgs(argv);
  if (!flags.name) throw new UsageError('schedule add needs --name');
  // A scheduled run must end by itself, so the preset defaults to a topic target instead of endless.
  const given = (flag: string) => runArgv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  const run = parseRunArgs(given('run-mode') ? runArgv : [...runArgv, '--run-mode', 'topics:15-40']);
  if (run.json) throw new UsageError('--json does not apply to schedule add');
  const id = flags.id ?? newId();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new UsageError(`Invalid --id ${id}`);
  let trigger: ScheduleSpec['trigger'];
  if (flags.cron !== undefined) {
    if (flags.runs !== undefined || flags.window !== undefined) throw new UsageError('--cron excludes --runs and --window');
    trigger = { kind: 'cron', expression: flags.cron };
  } else {
    const w = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(flags.window ?? '');
    if (!flags.runs || !w) throw new UsageError('schedule add needs --cron "<expression>", or --runs <n> with --window HH:MM-HH:MM');
    trigger = {
      kind: 'daily-window',
      runs: minutesFlag(flags.runs, 'runs', 0),
      start: w[1]!,
      end: w[2]!,
      jitterMinutes: minutesFlag(flags.jitter, 'jitter', 15),
      minGapMinutes: minutesFlag(flags['min-gap'], 'min-gap', 60),
    };
  }
  if (flags.misfire !== undefined && flags.misfire !== 'skip' && flags.misfire !== 'run-once') throw new UsageError('--misfire must be skip or run-once');
  const categories = resolveCategories(run.site, known(run.site.id), run.categories);
  const spec: ScheduleSpec = {
    id,
    name: flags.name,
    profileId: `${run.site.id}/${run.profile}`,
    presetId: id,
    enabled: !flags.disabled,
    browserMode: given('headed') ? 'headed' : 'headless',
    timezone: flags.timezone ?? systemTimezone(),
    trigger,
    misfire: { policy: flags.misfire ?? 'skip', graceMinutes: minutesFlag(flags.grace, 'grace', 30) },
    overlap: 'skip',
    unavailableDisplay: flags['fallback-headless'] ? 'fallback-headless' : 'skip',
    runOnStart: flags['run-on-start'] ?? false,
  };
  const preset: RunPreset = {
    id,
    siteId: run.site.id,
    browseMode: run.browseMode,
    runMode: run.runMode,
    categoryPaths: categories.map((c) => c.path),
    interaction: run.interaction,
    extraWait: run.extraWait,
    samplePerCategory: { min: 3, max: 8 },
    experiments: run.experiments,
  };
  return { spec, preset };
}

function triggerLine(spec: ScheduleSpec): string {
  const t = spec.trigger;
  const when = t.kind === 'cron' ? `cron "${t.expression}"` : `${t.runs}× daily in ${t.start}-${t.end} (±${t.jitterMinutes} min, gap ≥ ${t.minGapMinutes} min)`;
  return `${when} ${spec.timezone}`;
}

const localTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

function historyLine(e: HistoryEntry, timeZone: string): string {
  const ended = e.ended ? ` → ${e.ended.outcome} (${e.ended.stopCause}${e.ended.failure ? `, ${e.ended.failure}` : ''})` : '';
  return `${localTime(e.at, timeZone)} ${e.cause} ${e.outcome}${e.reason ? ` (${e.reason})` : ''}${ended}`;
}

export interface ListedSchedule {
  spec: ScheduleSpec;
  paused: boolean;
  next: RunPlanSnapshot | null;
  history: HistoryEntry[];
}

/** Definitions joined with the persisted plan, as of `now`; reads only, so it works while `serve` runs. */
export function listSchedules(book: ScheduleBook, state: SchedulerState | null, now: number): ListedSchedule[] {
  return book.schedules.map((spec) => {
    const s: ScheduleState | undefined = state?.schedules[spec.id];
    const next = s?.planned
      .filter((p) => p.status === 'pending' && Date.parse(p.snapshot.plannedAt) > now)
      .sort((a, b) => Date.parse(a.snapshot.plannedAt) - Date.parse(b.snapshot.plannedAt))[0];
    return { spec, paused: s?.paused ?? false, next: next?.snapshot ?? null, history: s?.history ?? [] };
  });
}

export function formatSchedules(items: ListedSchedule[]): string {
  if (items.length === 0) return 'No schedules. Add one with `lurk schedule add`.';
  return items
    .map(({ spec, paused, next, history }) => {
      const status = !spec.enabled ? 'disabled' : paused ? 'paused' : 'active';
      const lines = [`${spec.id}  ${spec.name}  [${status}]  ${spec.profileId} · ${spec.browserMode} · ${triggerLine(spec)}`];
      if (next) {
        const mode = next.preset.runMode;
        const target = mode.kind === 'topics' ? `${mode.count} topics` : mode.kind === 'time' ? `${mode.minutes} min` : 'endless';
        lines.push(`  next ${localTime(next.plannedAt, spec.timezone)} · ${next.preset.browseMode} · ${target} · ${next.preset.categories.length} categories`);
      } else {
        lines.push('  next: not planned yet (lurk serve plans runs while it runs)');
      }
      for (const e of history.slice(-3)) lines.push(`  ${historyLine(e, spec.timezone)}`);
      return lines.join('\n');
    })
    .join('\n');
}

export async function schedule(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const dir = schedulesDir();
  const book = new FileScheduleBook(dir);
  const categories = new CategoryCache();
  const idArg = () => {
    const [id, ...more] = rest;
    if (!id || more.length > 0 || id.startsWith('-')) throw new UsageError(`schedule ${sub} takes one schedule id`);
    return id;
  };
  switch (sub) {
    case 'list': {
      const json = rest.includes('--json');
      if (rest.some((a) => a !== '--json')) throw new UsageError('schedule list only takes --json');
      const items = listSchedules(await book.load(), await new FileScheduleStore(dir).load(), Date.now());
      console.log(json ? JSON.stringify(items, null, 2) : formatSchedules(items));
      return EXIT.ok;
    }
    case 'add': {
      const current = await book.load();
      const site = rest.find((a, i) => rest[i - 1] === '--site') ?? rest.find((a) => a.startsWith('--site='))?.slice(7) ?? process.env.LURK_SITE ?? 'linuxdo';
      await categories.refresh([site]);
      const { spec, preset } = buildScheduleFromArgs(rest, (id) => categories.known(id), () => randomUUID().slice(0, 8));
      if (current.schedules.some((s) => s.id === spec.id)) throw new UsageError(`Schedule ${spec.id} already exists`);
      await book.save({ schedules: [...current.schedules, spec], presets: [...current.presets.filter((p) => p.id !== preset.id), preset] });
      console.log(`Added schedule ${spec.id} (${triggerLine(spec)}). A running lurk serve picks it up within a minute.`);
      return EXIT.ok;
    }
    case 'remove': {
      const id = idArg();
      const current = await book.load();
      const spec = current.schedules.find((s) => s.id === id);
      if (!spec) throw new UsageError(`No schedule ${id}`);
      const schedules = current.schedules.filter((s) => s.id !== id);
      const presets = current.presets.filter((p) => p.id !== spec.presetId || schedules.some((s) => s.presetId === p.id));
      await book.save({ schedules, presets });
      // The plan and history go with it when no other process owns them; a running serve simply stops planning it.
      try {
        const lock = await acquireSchedulerLock(dir);
        try {
          const store = new FileScheduleStore(dir);
          const state = await store.load();
          if (state?.schedules[id]) {
            delete state.schedules[id];
            await store.save(state);
          }
        } finally {
          await lock.release();
        }
      } catch (err) {
        if (!(err instanceof SchedulerLockedError)) throw err;
      }
      console.log(`Removed schedule ${id}.`);
      return EXIT.ok;
    }
    case 'pause':
    case 'resume':
    case 'run-now':
      return controlSchedule(sub, rest, dir, book, categories);
    default:
      throw new UsageError(sub ? `Unknown schedule command ${sub}` : 'schedule needs a command');
  }
}

async function controlSchedule(sub: 'pause' | 'resume' | 'run-now', rest: string[], dir: string, book: FileScheduleBook, categories: CategoryCache): Promise<number> {
  const json = sub === 'run-now' && rest.includes('--json');
  const args = rest.filter((a) => !(json && a === '--json'));
  const [id, ...more] = args;
  if (!id || more.length > 0 || id.startsWith('-')) throw new UsageError(`schedule ${sub} takes one schedule id${sub === 'run-now' ? ' and optionally --json' : ''}`);
  const current = await book.load();
  if (!current.schedules.some((s) => s.id === id)) throw new UsageError(`No schedule ${id}`);
  await categories.refresh(current.presets.map((p) => p.siteId));
  const reporter = createReporter(json, Date.now());
  const host = await SchedulerHost.open(dir, {
    displayAvailable: () => true,
    presets: () => current.presets,
    categories,
    emit: reporter.event,
    log: (m) => console.error(m),
  });
  const onInterrupt = () => host.stopAll('user');
  process.on('SIGINT', onInterrupt);
  try {
    await host.scheduler.adopt(current.schedules);
    if (sub === 'pause') {
      await host.scheduler.pause(id);
      console.log(`Paused ${id}; runs that come due are skipped and recorded until it is resumed.`);
      return EXIT.ok;
    }
    if (sub === 'resume') {
      await host.scheduler.resume(id);
      console.log(`Resumed ${id}.`);
      return EXIT.ok;
    }
    let runId: RunId;
    try {
      runId = await host.scheduler.trigger(id, 'manual');
    } catch (err) {
      if (err instanceof ScheduleSkipped) {
        console.error(`Not started: ${err.reason}`);
        return EXIT.environment;
      }
      throw err;
    }
    const result = await host.wait(runId);
    if (!result) return EXIT.environment;
    reporter.result(result);
    return exitCodeFor(result);
  } finally {
    process.off('SIGINT', onInterrupt);
    await host.close();
  }
}
