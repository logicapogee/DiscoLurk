import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { FileCategoryStore, FileLedgerStore, validateReplyTemplates } from '@disco-lurk/config';
import {
  EXPERIMENTS_OFF,
  isAbortError,
  MAX_REPLY_LIKES,
  reportedTopicsShortfall,
  resolvePreset,
  seededRandom,
  systemDeps,
  type AuthSession,
  type BrowseMode,
  type BrowserChannel,
  type BrowserMode,
  type Category,
  type CategoryStore,
  type CoordinatorEnv,
  type ExperimentFlags,
  type InteractionPolicy,
  type LevelSnapshot,
  type RunEvent,
  type RunModeSpec,
  type RunPlanSnapshot,
  type RunPreset,
  type RunResult,
  type Site,
  type WaitRange,
} from '@disco-lurk/core';
import { CATEGORY_PATH, openDiscourseForum, type Credentials } from '@disco-lurk/site-discourse';
import templatesFile from '../../../data/reply-templates.json';
import { ledgersDir, profilesDir, sitesDir } from './paths';
import { BUILTIN_SITES, findSite } from './sites';

/** CLI exit codes. */
export const EXIT = { ok: 0, cancelled: 2, needsAuth: 3, environment: 4, contract: 5, noProgress: 6 } as const;

export class UsageError extends Error {}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A Profile is addressed as `<siteId>/<name>`, matching its directory `profiles/<siteId>/<name>`. */
export const profileIdOf = (siteId: string, name: string) => `${siteId}/${name}`;

export function parseProfileId(profileId: string): { siteId: string; name: string } {
  const [siteId, name, ...rest] = profileId.split('/');
  if (!siteId || !name || rest.length > 0 || !PROFILE_NAME.test(name)) throw new UsageError(`Invalid profile id ${profileId}`);
  return { siteId, name };
}

/** The longest time target: one day. */
export const MAX_RUN_MINUTES = 24 * 60;

/** Run mode syntax: `endless`, `topics:<n>`, `topics:<min>-<max>`, `time:<minutes>`. */
export function parseRunMode(raw: string): RunModeSpec {
  if (raw === 'endless') return { kind: 'endless' };
  const topics = /^topics:(\d+)(?:-(\d+))?$/.exec(raw);
  if (topics) {
    const min = Number(topics[1]);
    const max = topics[2] === undefined ? min : Number(topics[2]);
    if (min < 1 || max < min) throw new UsageError(`Invalid topic range in --run-mode ${raw}`);
    return { kind: 'topics', min, max };
  }
  const time = /^time:(\d+)$/.exec(raw);
  if (time && Number(time[1]) > MAX_RUN_MINUTES) throw new UsageError(`--run-mode time:<minutes> allows at most ${MAX_RUN_MINUTES} minutes (24 hours), not ${time[1]}`);
  if (time && Number(time[1]) > 0) return { kind: 'time', minutes: Number(time[1]) };
  throw new UsageError(`--run-mode must be endless, topics:<n>, topics:<min>-<max> or time:<minutes>, not ${raw}`);
}

function parseChannel(raw: string): BrowserChannel {
  if (raw !== 'chrome' && raw !== 'msedge') throw new UsageError('--channel must be chrome or msedge');
  return raw;
}

function parseSite(raw: string | undefined): Site {
  const id = raw ?? process.env.LURK_SITE ?? 'linuxdo';
  const site = findSite(id);
  if (!site) throw new UsageError(`Unknown site ${id}; known: ${BUILTIN_SITES.map((s) => s.id).join(', ')}`);
  return site;
}

function parseProfileName(raw: string): string {
  if (!PROFILE_NAME.test(raw)) throw new UsageError(`Invalid --profile ${raw}`);
  return raw;
}

/** Options every browser command takes. */
const COMMON = {
  site: { type: 'string' },
  profile: { type: 'string', default: 'default' },
  channel: { type: 'string', default: 'chrome' },
} as const satisfies ParseArgsOptionsConfig;

function parseOrUsageError<O extends ParseArgsOptionsConfig>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, strict: true, options }).values;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export interface LoginArgs {
  site: Site;
  profile: string;
  channel: BrowserChannel;
}

function loginArgsFrom(v: { site?: string | undefined; profile: string; channel: string }): LoginArgs {
  return { site: parseSite(v.site), profile: parseProfileName(v.profile), channel: parseChannel(v.channel) };
}

export interface RunArgs extends LoginArgs {
  browseMode: BrowseMode;
  runMode: RunModeSpec;
  categories: string[] | null;
  browserMode: BrowserMode;
  json: boolean;
  interaction: InteractionPolicy;
  extraWait: WaitRange & { enabled: boolean };
  experiments: ExperimentFlags;
  /** Options that were given but have no effect as combined, for stderr. */
  usageWarnings: string[];
}

/** The default RunPreset's interaction settings: likes and replies off, at the field-tested rates. */
export const DEFAULT_INTERACTION: InteractionPolicy = {
  like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
  reply: { enabled: false, rate: 5, riskAcknowledged: false },
};

export const DEFAULT_EXTRA_WAIT: WaitRange & { enabled: boolean } = { enabled: true, minSec: 1, maxSec: 3 };

/** The flag a command line must carry to turn on automatic replies; there is no other way to turn them on. */
export const REPLY_RISK_FLAG = 'i-understand-auto-reply-risk';

export const REPLY_RISK_NOTICE =
  'Automatic replies post real messages under your account. Sites may detect and penalise automated replies. ' +
  `Add --${REPLY_RISK_FLAG} to confirm that you accept this risk.`;

function parsePercent(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || n < 0 || n > 100) throw new UsageError(`--${flag} must be a percentage from 0 to 100`);
  return n;
}

function parseCount(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} must be a whole number`);
  return Number(raw);
}

/** `--extra-wait <min>-<max>` in seconds, or `off`. */
export function parseExtraWait(raw: string | undefined): WaitRange & { enabled: boolean } {
  if (raw === undefined) return { ...DEFAULT_EXTRA_WAIT };
  if (raw === 'off') return { ...DEFAULT_EXTRA_WAIT, enabled: false };
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m || Number(m[1]) > Number(m[2])) throw new UsageError('--extra-wait must be <min>-<max> in seconds, or off');
  return { enabled: true, minSec: Number(m[1]), maxSec: Number(m[2]) };
}

const EXPERIMENT_NAMES = Object.keys(EXPERIMENTS_OFF) as Array<keyof ExperimentFlags>;

export function parseExperiments(raw: string | undefined): ExperimentFlags {
  const flags: ExperimentFlags = { ...EXPERIMENTS_OFF };
  for (const name of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const known = EXPERIMENT_NAMES.find((n) => n === name);
    if (!known) throw new UsageError(`Unknown experiment ${name}; known: ${EXPERIMENT_NAMES.join(', ')}`);
    flags[known] = true;
  }
  return flags;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const v = parseOrUsageError(argv, {
    ...COMMON,
    'browse-mode': { type: 'string', default: 'deep' },
    'run-mode': { type: 'string', default: 'endless' },
    categories: { type: 'string' },
    headed: { type: 'boolean' },
    headless: { type: 'boolean' },
    json: { type: 'boolean', default: false },
    like: { type: 'boolean', default: false },
    'like-rate': { type: 'string' },
    'reply-like-rate': { type: 'string' },
    'max-reply-likes': { type: 'string' },
    reply: { type: 'boolean', default: false },
    'reply-rate': { type: 'string' },
    [REPLY_RISK_FLAG]: { type: 'boolean', default: false },
    'extra-wait': { type: 'string' },
    experiments: { type: 'string' },
  });
  if (v.headed && v.headless) throw new UsageError('--headed and --headless exclude each other');
  if (v['browse-mode'] !== 'deep' && v['browse-mode'] !== 'quick') throw new UsageError('--browse-mode must be deep or quick');
  if (v.reply && !v[REPLY_RISK_FLAG]) throw new UsageError(REPLY_RISK_NOTICE);
  const d = DEFAULT_INTERACTION;
  const usageWarnings: string[] = [];
  const likeOptions = (['like-rate', 'reply-like-rate', 'max-reply-likes'] as const).filter((f) => v[f] !== undefined);
  if (!v.like && likeOptions.length > 0) usageWarnings.push(`${likeOptions.map((f) => `--${f}`).join(', ')} take effect only with --like`);
  if (!v.reply && v['reply-rate'] !== undefined) usageWarnings.push('--reply-rate takes effect only with --reply');
  if (!v.reply && v[REPLY_RISK_FLAG]) usageWarnings.push(`--${REPLY_RISK_FLAG} takes effect only with --reply`);
  let maxReplies = parseCount(v['max-reply-likes'], 'max-reply-likes', d.like.maxReplies);
  if (maxReplies > MAX_REPLY_LIKES) {
    usageWarnings.push(`--max-reply-likes ${maxReplies} is above the limit; ${MAX_REPLY_LIKES} reply floors at most are liked per topic`);
    maxReplies = MAX_REPLY_LIKES;
  }
  return {
    ...loginArgsFrom(v),
    browseMode: v['browse-mode'],
    runMode: parseRunMode(v['run-mode']),
    categories: v.categories ? v.categories.split(',').map((s) => s.trim()).filter(Boolean) : null,
    browserMode: v.headless ? 'headless' : 'headed',
    json: v.json,
    interaction: {
      like: {
        enabled: v.like,
        topicRate: parsePercent(v['like-rate'], 'like-rate', d.like.topicRate),
        replyRate: parsePercent(v['reply-like-rate'], 'reply-like-rate', d.like.replyRate),
        maxReplies,
      },
      reply: { enabled: v.reply, rate: parsePercent(v['reply-rate'], 'reply-rate', d.reply.rate), riskAcknowledged: v[REPLY_RISK_FLAG] },
    },
    extraWait: parseExtraWait(v['extra-wait']),
    experiments: parseExperiments(v.experiments),
    usageWarnings,
  };
}

export function parseLoginArgs(argv: string[]): LoginArgs {
  return loginArgsFrom(parseOrUsageError(argv, COMMON));
}

/**
 * `--categories` names categories by path (`/c/bank/6`) or by slug (`bank`). A path the site's
 * list does not know yet is still usable: a discovered site may be run before its first discovery.
 */
export function resolveCategories(site: Site, known: readonly Category[], tokens: string[] | null): Category[] {
  if (tokens === null) return known.filter((c) => c.enabledByDefault);
  return tokens.map((token) => {
    const path = token.replace(/\/$/, '');
    const hit = known.find((c) => c.path === path || c.path.split('/').at(-2) === token);
    if (hit) return hit;
    const m = CATEGORY_PATH.exec(path);
    if (!m) throw new UsageError(`Unknown category ${token} on ${site.id}; use a path like /c/<slug>/<id>`);
    return { name: m[1]!.split('/').at(-1)!, path, id: Number(m[2]), enabledByDefault: true };
  });
}

/** The CLI's default RunPreset, with this command line's choices, resolved the way every entry point resolves a preset. */
export function buildPlan(args: RunArgs, categories: Category[], seed: number, now: Date, warn?: (code: string, message: string) => void): RunPlanSnapshot {
  const at = now.toISOString();
  const preset: RunPreset = {
    id: 'cli',
    siteId: args.site.id,
    browseMode: args.browseMode,
    runMode: args.runMode,
    categoryPaths: categories.map((c) => c.path),
    interaction: args.interaction,
    extraWait: args.extraWait,
    samplePerCategory: { min: 3, max: 8 },
    experiments: args.experiments,
  };
  return {
    id: `run-${now.getTime()}-${seed.toString(16)}`,
    siteId: args.site.id,
    profileId: profileIdOf(args.site.id, args.profile),
    browserMode: args.browserMode,
    seed,
    plannedAt: at,
    materializedAt: at,
    preset: resolvePreset(preset, categories, seededRandom(seed), warn),
  };
}

/** The failure decides first; without one, a stop by the user or the app counts as cancelled. */
export function exitCodeFor(result: Pick<RunResult, 'outcome' | 'stopCause' | 'failure'>): number {
  switch (result.failure?.code) {
    case undefined:
      break;
    case 'needs-auth':
    case 'challenge-detected':
      return EXIT.needsAuth;
    case 'selector-contract-broken':
      return EXIT.contract;
    case 'no-progress':
    case 'no-candidates':
      return EXIT.noProgress;
    case 'cancelled':
      return EXIT.cancelled;
    default:
      return EXIT.environment;
  }
  if (result.stopCause === 'user' || result.stopCause === 'app-exit' || result.outcome === 'cancelled') return EXIT.cancelled;
  return result.outcome === 'completed' ? EXIT.ok : EXIT.environment;
}

/**
 * `lurk login` succeeds once `#current-user` shows in the headed window. It runs no headless
 * check afterwards, since a headless visit to linuxdo may meet a Cloudflare challenge; that check is `doctor`'s.
 */
export async function signIn(auth: AuthSession, signal: AbortSignal, log: (line: string) => void): Promise<number> {
  try {
    const result = await auth.continueWaiting(signal);
    if (result.status !== 'authenticated') {
      log(`Not signed in: ${result.status}`);
      return EXIT.needsAuth;
    }
    log(`Signed in${result.username ? ` as ${result.username}` : ''}.`);
    return EXIT.ok;
  } catch (err) {
    if (isAbortError(err)) return EXIT.cancelled;
    throw err;
  } finally {
    await auth.close();
  }
}

export interface CliEnvOptions {
  channel: BrowserChannel;
  credentials?: Credentials;
  exitSignal?: AbortSignal;
}

/** The bundled reply templates, checked before any run may use them. */
export function replyTemplates(file: { templates: string[] } = templatesFile): string[] {
  const problems = validateReplyTemplates(file.templates);
  if (problems.length > 0) throw new Error(`data/reply-templates.json is invalid: ${problems.join('; ')}`);
  return file.templates.map((t) => t.trim());
}

export function cliEnv(opts: CliEnvOptions): CoordinatorEnv {
  const deps = systemDeps();
  const templates = replyTemplates();
  return {
    deps,
    async resolveProfile(profileId) {
      const { siteId } = parseProfileId(profileId);
      const site = findSite(siteId);
      if (!site) throw new UsageError(`Unknown site ${siteId}`);
      return { profile: { id: profileId, siteId, channel: opts.channel }, site };
    },
    open(req) {
      const { siteId, name } = parseProfileId(req.profile.id);
      return openDiscourseForum({
        site: req.site,
        profileDir: join(profilesDir(), siteId, name),
        runId: req.runId,
        channel: req.profile.channel,
        headless: req.browserMode === 'headless',
        deps,
        warn: req.warn,
        onTimings: req.timings,
        replyTemplates: templates,
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      });
    },
    categories: new FileCategoryStore(sitesDir()),
    ledgers: new FileLedgerStore(ledgersDir()),
    ...(opts.exitSignal ? { exitSignal: opts.exitSignal } : {}),
  };
}

/** Unattended credentials come only from the environment, and only for password sites. */
export function credentialsFromEnv(site: Site, env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  if (site.login !== 'password' || !env.LURK_USERNAME || !env.LURK_PASSWORD) return undefined;
  return { username: env.LURK_USERNAME, password: env.LURK_PASSWORD };
}

export function siteCategories(site: Site, store: CategoryStore): Promise<Category[]> {
  return site.categorySource === 'builtin' ? Promise.resolve(site.builtinCategories ?? []) : store.load(site.id);
}

/** The run summary's interaction part: what is on, at which rates. */
export function interactionLine(i: InteractionPolicy): string {
  const likes = i.like.enabled ? `on (floor 1 ${i.like.topicRate}%, replies ${i.like.replyRate}% up to ${i.like.maxReplies})` : 'off';
  const replies = i.reply.enabled ? `on (${i.reply.rate}%)` : 'off';
  return `${likes} · replies ${replies}`;
}

export const newSeed = () => randomInt(0, 2 ** 31);

const clock = (iso: string, start: number) => {
  const s = Math.max(0, Math.round((Date.parse(iso) - start) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function formatEvent(e: RunEvent, startMs: number): string | null {
  const t = `[${clock(e.at, startMs)}]`;
  switch (e.type) {
    case 'state':
      return `${t} state ${e.state}`;
    case 'topic':
      return `${t} topic ${e.topicId} ${e.phase}${e.result ? ` (${e.result})` : ''}`;
    case 'floor':
      return `${t}   floor ${e.from} → ${e.to}${e.confirmed ? '' : ' (estimated)'}`;
    case 'action':
      return `${t} ${e.action} ${e.result}`;
    case 'timings':
      return `${t}   timings ${e.postsReported} posts, ${e.topicSeconds} s`;
    case 'stats':
      return null;
    case 'levels':
      return `${t} site progress (${e.kind}): ${levelSummary(e.snapshot)} · ${e.snapshot.metrics.length} metrics`;
    case 'warning':
      return `${t} warning ${e.code}: ${e.message}`;
    case 'error':
      return `${t} error ${e.error.code}: ${e.error.message}`;
  }
}

/** Who, which level and how far, from a progress page snapshot. */
function levelSummary(s: LevelSnapshot): string {
  return [s.username ? `@${s.username}` : null, s.level !== undefined ? `level ${s.level}` : null, s.percent !== undefined ? `${s.percent}%` : null].filter(Boolean).join(' · ');
}

function levelLines(levels: RunResult['levels'], baseline: RunResult['baseline']): string[] {
  const { initial, final } = levels;
  if (baseline === 'not-applicable' && !final) return ['site progress: this site has no progress page'];
  const shown = final ?? initial;
  const lines = [`site progress (${final?.source ?? initial?.source ?? 'unread'})${baseline === 'missing' ? ' — no baseline' : ''}: ${shown ? levelSummary(shown) : ''}`];
  const labels = [...new Set([...(initial?.metrics ?? []), ...(final?.metrics ?? [])].map((m) => m.label))];
  for (const label of labels) {
    const a = initial?.metrics.find((m) => m.label === label);
    const b = final?.metrics.find((m) => m.label === label);
    const req = (b ?? a)?.required;
    const target = req === null || req === undefined ? '' : ` / ${req}`;
    // Without a baseline only the final value is shown, never a change.
    if (baseline === 'missing' || !a) lines.push(`  ${label}: ${b?.current ?? '?'}${target}`);
    else if (!b) lines.push(`  ${label}: ${a.current} → (not read)${target}`);
    else lines.push(`  ${label}: ${a.current} → ${b.current} (${b.current - a.current >= 0 ? '+' : ''}${b.current - a.current})${target}`);
  }
  return lines;
}

export interface Reporter {
  /** `intro` is the human line naming site, Profile, browser and mode. */
  plan(plan: RunPlanSnapshot, intro: string): void;
  event(e: RunEvent): void;
  result(result: RunResult): void;
}

/** `--json` prints one JSON object per line; otherwise readable lines timed from `start`. */
export function createReporter(json: boolean, start: number, write: (line: string) => void = console.log): Reporter {
  if (json) {
    return {
      plan: (plan) => write(JSON.stringify({ type: 'plan', plan })),
      event: (e) => write(JSON.stringify(e)),
      result: (result) => write(JSON.stringify({ type: 'result', result })),
    };
  }
  return {
    plan: (_plan, intro) => write(intro),
    event: (e) => {
      const line = formatEvent(e, start);
      if (line) write(line);
    },
    result: (result) => write(`\n${formatSummary(result)}`),
  };
}

/** Attempted, confirmed and the site's reported values side by side. */
export function formatSummary(result: RunResult): string {
  const { attempted: a, confirmed: c } = result.stats;
  const lines = [
    `result: ${result.outcome} (${result.stopCause})${result.failure ? ` — ${result.failure.code}: ${result.failure.message}` : ''}`,
    `attempted: topics ${a.topics}, floors ${a.floors}, likes ${a.likes}, reply likes ${a.replyLikes}, replies ${a.replies}`,
    `confirmed: topics ${c.topics}, floors ${c.floors}, likes ${c.likes}, reply likes ${c.replyLikes}, replies ${c.replies}`,
    `estimated floors: ${result.stats.estimatedFloors} · reported by the browser (/topics/timings): ${result.stats.timings.posts} floors, ${result.stats.timings.topicSeconds} s · elapsed ${Math.round(result.stats.elapsedMs / 1000)} s`,
    `returns: ${Object.entries(result.stats.returns)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`,
    ...levelLines(result.levels, result.baseline),
  ];
  const missing = reportedTopicsShortfall(result.stats);
  if (missing !== null) lines.push(`site statistics may lag: the site shows ${missing} fewer topics than confirmed`);
  return lines.join('\n');
}
