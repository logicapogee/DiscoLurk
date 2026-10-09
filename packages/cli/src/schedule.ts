import { randomUUID } from 'node:crypto';
import { DEFAULT_SAMPLE, type Category, type RunPlanSnapshot, type RunPreset, type ScheduleSpec, type SiteId } from '@disco-lurk/core';
import { acquireSchedulerLock, FileScheduleBook, FileScheduleStore, SchedulerLockedError, schedulesDirOf, type ScheduleBook } from '@disco-lurk/config';
import type { HistoryEntry, ScheduleState, SchedulerState } from '@disco-lurk/scheduler';
import { HttpError, type RunRecord } from '@disco-lurk/server';
import { cliServices } from './cli-services';
import { EnvError, envScheduleArgv } from './env';
import { appDataDir } from './paths';
import { createReporter, EXIT, exitCodeFor, parseRunArgs, resolveCategories, UsageError } from './run';

export const schedulesDir = (base = appDataDir()) => schedulesDirOf(base);

export const SCHEDULE_USAGE = `  lurk schedule list [--json]
  lurk schedule add --name <name> [--id <id>] --site <id> [--profile <name>]
           (--cron "<min hour dom month dow>" | --runs <n> --window <HH:MM-HH:MM> [--jitter <min>] [--min-gap <min>])
           [--timezone <IANA>] [--headed|--headless] [--fallback-headless] [--misfire skip|run-once] [--grace <min>]
           [--run-on-start] [--disabled] [lurk run options: --browse-mode --run-mode --categories --like … ]
  lurk schedule remove|pause|resume <id>
  lurk schedule run-now|trigger <id> [--json]`;

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
  const given = (flag: string) => runArgv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  const run = parseRunArgs(runArgv);
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
    samplePerCategory: { ...DEFAULT_SAMPLE },
    experiments: run.experiments,
  };
  return { spec, preset };
}

/**
 * The LURK_* schedule, built by `schedule add`'s own parser from the command line the variables
 * map to; categories resolve against `known`, the site's list as it is now.
 */
export function envSchedule(env: NodeJS.ProcessEnv, defaultTimezone: string, known: (siteId: SiteId) => Category[] = () => []): { spec: ScheduleSpec; preset: RunPreset } | null {
  const argv = envScheduleArgv(env, defaultTimezone);
  if (!argv) return null;
  try {
    return buildScheduleFromArgs(argv, known, () => argv[1]!);
  } catch (err) {
    if (err instanceof UsageError) throw new EnvError(`LURK_* schedule: ${err.message}`);
    throw err;
  }
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
      const { catalog } = await cliServices.catalogOnly(appDataDir());
      const { spec, preset } = buildScheduleFromArgs(rest, (id) => catalog.categories(id), () => randomUUID().slice(0, 8));
      if (current.schedules.some((s) => s.id === spec.id)) throw new UsageError(`Schedule ${spec.id} already exists`);
      await book.withSchedule(spec, preset);
      console.log(`Added schedule ${spec.id} (${triggerLine(spec)}). A running lurk serve picks it up within a minute.`);
      return EXIT.ok;
    }
    case 'remove': {
      const id = idArg();
      if (!(await book.withoutSchedule(id))) throw new UsageError(`No schedule ${id}`);
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
    case 'trigger':
      return controlSchedule(sub === 'trigger' ? 'run-now' : sub, rest, book);
    default:
      throw new UsageError(sub ? `Unknown schedule command ${sub}` : 'schedule needs a command');
  }
}

/**
 * Pause, resume and run-now go through the same schedule service as `lurk serve`, holding the
 * state lock for the command's duration; a run started here is a run like any from the server.
 */
async function controlSchedule(sub: 'pause' | 'resume' | 'run-now', rest: string[], book: FileScheduleBook): Promise<number> {
  const json = sub === 'run-now' && rest.includes('--json');
  const args = rest.filter((a) => !(json && a === '--json'));
  const [id, ...more] = args;
  if (!id || more.length > 0 || id.startsWith('-')) throw new UsageError(`schedule ${sub} takes one schedule id${sub === 'run-now' ? ' and optionally --json' : ''}`);
  if (!(await book.load()).schedules.some((s) => s.id === id)) throw new UsageError(`No schedule ${id}`);
  const reporter = createReporter(json, Date.now());
  const services = await cliServices.open(appDataDir(), { log: (m) => console.error(m) });
  const { schedules, runs, hub } = services;
  if (!schedules.available) {
    await services.close();
    throw new EnvError(
      `lurk serve or the desktop app is running (${schedules.unavailableReason?.match(/process -?\d+/)?.[0] ?? 'another process'}) and owns the schedules; ` +
        'pause, resume or run a schedule from its UI or its API (POST /schedules/<id>/pause, /resume, /trigger), or stop it first',
    );
  }
  const onInterrupt = () => runs.stopAll('user');
  process.on('SIGINT', onInterrupt);
  try {
    if (sub !== 'run-now') {
      await schedules.control(id, sub);
      console.log(sub === 'pause' ? `Paused ${id}; runs that come due are skipped and recorded until it is resumed.` : `Resumed ${id}.`);
      return EXIT.ok;
    }
    // Subscribed before the trigger: the run's first events may arrive before it returns. This
    // process runs nothing else, so every frame belongs to that run.
    let record: RunRecord | undefined;
    const unsubscribe = hub.subscribe((f) => {
      if (f.type === 'event') reporter.event(f.event);
      if (f.type === 'run' && f.record) record = f.record;
    });
    try {
      await schedules.trigger(id, 'manual');
    } catch (err) {
      unsubscribe();
      if (err instanceof HttpError && err.code.startsWith('skipped-')) {
        console.error(`Not started: ${err.code.slice('skipped-'.length)}`);
        return EXIT.environment;
      }
      throw err;
    }
    await runs.settle();
    unsubscribe();
    if (!record) return EXIT.environment;
    reporter.result(record.result);
    return exitCodeFor(record.result);
  } finally {
    process.off('SIGINT', onInterrupt);
    await services.close();
  }
}
