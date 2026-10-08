import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FileCategoryStore } from '@disco-lurk/config';
import {
  resolveRunMode,
  seededRandom,
  systemDeps,
  type BrowseMode,
  type BrowserChannel,
  type BrowserMode,
  type Category,
  type CoordinatorEnv,
  type LevelSnapshot,
  type RunEvent,
  type RunModeSpec,
  type RunPlanSnapshot,
  type RunResult,
  type Site,
} from '@disco-lurk/core';
import { CATEGORY_PATH, openDiscourseForum, type Credentials } from '@disco-lurk/site-discourse';
import { profilesDir, sitesDir } from './paths';
import { BUILTIN_SITES, findSite } from './sites';

/** §11.1 exit codes. */
export const EXIT = { ok: 0, cancelled: 2, needsAuth: 3, environment: 4, contract: 5, noProgress: 6 } as const;

export class UsageError extends Error {}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A Profile is addressed as `<siteId>/<name>`, matching its directory `profiles/<siteId>/<name>` (§8.3). */
export const profileIdOf = (siteId: string, name: string) => `${siteId}/${name}`;

export function parseProfileId(profileId: string): { siteId: string; name: string } {
  const [siteId, name, ...rest] = profileId.split('/');
  if (!siteId || !name || rest.length > 0 || !PROFILE_NAME.test(name)) throw new UsageError(`Invalid profile id ${profileId}`);
  return { siteId, name };
}

/** §9.3 / §11.1 run mode syntax: `endless`, `topics:<n>`, `topics:<min>-<max>`, `time:<minutes>`. */
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

export interface RunArgs {
  site: Site;
  profile: string;
  browseMode: BrowseMode;
  runMode: RunModeSpec;
  categories: string[] | null;
  browserMode: BrowserMode;
  channel: BrowserChannel;
  json: boolean;
}

export function parseRunArgs(argv: string[]): RunArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        site: { type: 'string' },
        profile: { type: 'string', default: 'default' },
        'browse-mode': { type: 'string', default: 'deep' },
        'run-mode': { type: 'string', default: 'endless' },
        categories: { type: 'string' },
        headed: { type: 'boolean' },
        headless: { type: 'boolean' },
        channel: { type: 'string', default: 'chrome' },
        json: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const v = parsed.values;
  if (v.headed && v.headless) throw new UsageError('--headed and --headless exclude each other');
  if (v['browse-mode'] !== 'deep' && v['browse-mode'] !== 'quick') throw new UsageError('--browse-mode must be deep or quick');
  return {
    site: parseSite(v.site),
    profile: parseProfileName(v.profile),
    browseMode: v['browse-mode'],
    runMode: parseRunMode(v['run-mode']),
    categories: v.categories ? v.categories.split(',').map((s) => s.trim()).filter(Boolean) : null,
    browserMode: v.headless ? 'headless' : 'headed',
    channel: parseChannel(v.channel),
    json: v.json,
  };
}

export interface LoginArgs {
  site: Site;
  profile: string;
  channel: BrowserChannel;
}

export function parseLoginArgs(argv: string[]): LoginArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        site: { type: 'string' },
        profile: { type: 'string', default: 'default' },
        channel: { type: 'string', default: 'chrome' },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  return { site: parseSite(parsed.values.site), profile: parseProfileName(parsed.values.profile), channel: parseChannel(parsed.values.channel) };
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

/** §11.1 default RunPreset, with this command line's choices. */
export function buildPlan(args: RunArgs, categories: Category[], seed: number, now: Date): RunPlanSnapshot {
  const at = now.toISOString();
  return {
    id: `run-${now.getTime()}-${seed.toString(16)}`,
    siteId: args.site.id,
    profileId: profileIdOf(args.site.id, args.profile),
    browserMode: args.browserMode,
    seed,
    plannedAt: at,
    materializedAt: at,
    preset: {
      presetId: 'cli',
      browseMode: args.browseMode,
      runMode: resolveRunMode(args.runMode, seededRandom(seed)),
      categories,
      interaction: {
        like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
        reply: { enabled: false, rate: 5 },
      },
      extraWait: { enabled: true, minSec: 1, maxSec: 3 },
      samplePerCategory: { min: 3, max: 8 },
    },
  };
}

/** §11.1: the failure decides first; without one, a stop by the user or the app counts as cancelled. */
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

export interface CliEnvOptions {
  channel: BrowserChannel;
  credentials?: Credentials;
  exitSignal?: AbortSignal;
}

export function cliEnv(opts: CliEnvOptions): CoordinatorEnv {
  const deps = systemDeps();
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
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      });
    },
    categories: new FileCategoryStore(sitesDir()),
    ...(opts.exitSignal ? { exitSignal: opts.exitSignal } : {}),
  };
}

/** B10: unattended credentials come only from the environment, and only for password sites. */
export function credentialsFromEnv(site: Site, env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  if (site.login !== 'password' || !env.LURK_USERNAME || !env.LURK_PASSWORD) return undefined;
  return { username: env.LURK_USERNAME, password: env.LURK_PASSWORD };
}

export async function siteCategories(site: Site): Promise<Category[]> {
  return site.categorySource === 'builtin' ? (site.builtinCategories ?? []) : new FileCategoryStore(sitesDir()).load(site.id);
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
      return `${t} timings ${e.postsReported} posts, ${e.topicSeconds} s`;
    case 'stats':
      return null;
    case 'warning':
      return `${t} warning ${e.code}: ${e.message}`;
    case 'error':
      return `${t} error ${e.error.code}: ${e.error.message}`;
  }
}

function levelLines(levels: RunResult['levels'], baseline: RunResult['baseline']): string[] {
  const { initial, final } = levels;
  if (baseline === 'not-applicable' && !final) return ['site progress: this site has no progress page'];
  const head = (s: LevelSnapshot | null) =>
    s ? [s.username ? `@${s.username}` : null, s.level !== undefined ? `level ${s.level}` : null, s.percent !== undefined ? `${s.percent}%` : null].filter(Boolean).join(' · ') : '';
  const lines = [`site progress (${final?.source ?? initial?.source ?? 'unread'})${baseline === 'missing' ? ' — no baseline' : ''}: ${head(final ?? initial)}`];
  const labels = [...new Set([...(initial?.metrics ?? []), ...(final?.metrics ?? [])].map((m) => m.label))];
  for (const label of labels) {
    const a = initial?.metrics.find((m) => m.label === label);
    const b = final?.metrics.find((m) => m.label === label);
    const req = (b ?? a)?.required;
    const target = req === null || req === undefined ? '' : ` / ${req}`;
    // S09: without a baseline only the final value is shown, never a change.
    if (baseline === 'missing' || !a) lines.push(`  ${label}: ${b?.current ?? '?'}${target}`);
    else if (!b) lines.push(`  ${label}: ${a.current} → (not read)${target}`);
    else lines.push(`  ${label}: ${a.current} → ${b.current} (${b.current - a.current >= 0 ? '+' : ''}${b.current - a.current})${target}`);
  }
  return lines;
}

/** S08: attempted, confirmed and the site's reported values side by side. */
export function formatSummary(result: RunResult): string {
  const { attempted: a, confirmed: c } = result.stats;
  const lines = [
    `result: ${result.outcome} (${result.stopCause})${result.failure ? ` — ${result.failure.code}: ${result.failure.message}` : ''}`,
    `attempted: topics ${a.topics}, floors ${a.floors}, likes ${a.likes}, reply likes ${a.replyLikes}, replies ${a.replies}`,
    `confirmed: topics ${c.topics}, floors ${c.floors}, likes ${c.likes}, reply likes ${c.replyLikes}, replies ${c.replies}`,
    `estimated floors: ${result.stats.estimatedFloors} · elapsed ${Math.round(result.stats.elapsedMs / 1000)} s`,
    ...levelLines(result.levels, result.baseline),
  ];
  return lines.join('\n');
}
