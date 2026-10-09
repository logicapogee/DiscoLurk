import { readFileSync } from 'node:fs';
import type { Site } from '@disco-lurk/core';
import { hasUserinfo, isLoopback, MIN_TOKEN_BYTES, TOKEN_REQUIREMENT, tokenStrongEnough } from '@disco-lurk/server';
import { parseCount, parsePercent, parseRunMode, UsageError } from './run';
import { BUILTIN_SITES, findSite } from './sites';

/** A LURK_* variable that is missing or malformed; the CLI exits with the environment code. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Unset and empty both mean "not configured", as compose files often pass `VAR=`. */
function read(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function bool(env: Env, name: string): boolean | undefined {
  const v = read(env, name)?.toLowerCase();
  if (v === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new EnvError(`${name} must be true or false, not "${env[name]}"`);
}

/** Reads a variable with the parser of the matching command-line option, naming the variable in its error. */
function viaOption<T>(env: Env, name: string, parse: (raw: string) => T): T | undefined {
  const v = read(env, name);
  if (v === undefined) return undefined;
  try {
    return parse(v);
  } catch (err) {
    if (err instanceof UsageError) throw new EnvError(`${err.message.replace(/--[a-z-]+/, name)}, not "${v}"`);
    throw err;
  }
}

const percent = (env: Env, name: string) => viaOption(env, name, (raw) => parsePercent(raw, 'value', 0));
const wholeNumber = (env: Env, name: string) => viaOption(env, name, (raw) => parseCount(raw, 'value', 0));

export function siteFromEnv(env: Env): Site {
  const id = read(env, 'LURK_SITE') ?? 'linuxdo';
  const site = findSite(id);
  if (!site) throw new EnvError(`LURK_SITE=${id} is not a known site; known: ${BUILTIN_SITES.map((s) => s.id).join(', ')}`);
  return site;
}

function browseModeFromEnv(env: Env): 'deep' | 'quick' | undefined {
  const v = read(env, 'LURK_BROWSE_MODE');
  if (v === undefined || v === 'deep' || v === 'quick') return v;
  throw new EnvError(`LURK_BROWSE_MODE must be deep or quick, not "${v}"`);
}

function runModeFromEnv(env: Env) {
  const v = read(env, 'LURK_RUN_MODE');
  if (v === undefined) return undefined;
  try {
    return parseRunMode(v);
  } catch (err) {
    if (err instanceof UsageError) throw new EnvError(`LURK_RUN_MODE: ${err.message.replace('--run-mode', 'the value')}`);
    throw err;
  }
}

const categoryTokens = (env: Env) =>
  read(env, 'LURK_CATEGORIES')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Checks the pairs that only work together; credentials are read where they are used. */
export function checkCredentialsEnv(env: Env): void {
  const user = read(env, 'LURK_USERNAME');
  const pass = read(env, 'LURK_PASSWORD');
  if ((user === undefined) !== (pass === undefined)) {
    throw new EnvError(`LURK_USERNAME and LURK_PASSWORD must be set together; only ${user === undefined ? 'LURK_PASSWORD' : 'LURK_USERNAME'} is set`);
  }
}

export function proxyFromEnv(env: Env): string | undefined {
  const v = read(env, 'LURK_PROXY');
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new EnvError(`LURK_PROXY must be a URL such as http://127.0.0.1:7890 or socks5://host:1080, not "${v}"`);
  }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new EnvError(`LURK_PROXY scheme must be http, https or socks5, not ${url.protocol}`);
  if (hasUserinfo(v)) throw new EnvError('LURK_PROXY must not carry a username or password; use a proxy that needs no authentication');
  return v;
}

const given = (argv: readonly string[], flag: string) => argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));

/**
 * `lurk run`'s command line with LURK_* values filled in for the options it leaves out, so an
 * explicit option always wins over the environment and the environment over built-in defaults.
 */
export function runArgvWithEnv(argv: readonly string[], env: Env): string[] {
  checkCredentialsEnv(env);
  proxyFromEnv(env);
  const extra: string[] = [];
  const add = (flag: string, value: string | undefined) => {
    if (value !== undefined && !given(argv, flag)) extra.push(`--${flag}`, value);
  };
  if (read(env, 'LURK_SITE') !== undefined) add('site', siteFromEnv(env).id);
  add('browse-mode', browseModeFromEnv(env));
  if (runModeFromEnv(env)) add('run-mode', read(env, 'LURK_RUN_MODE'));
  add('categories', categoryTokens(env)?.join(','));
  const like = bool(env, 'LURK_LIKE');
  if (like === true && !given(argv, 'like')) extra.push('--like');
  const likeRate = percent(env, 'LURK_LIKE_RATE');
  add('like-rate', likeRate === undefined ? undefined : String(likeRate));
  return [...argv, ...extra];
}

/**
 * Variables the table does not define but that look like turning replies on. Unattended replies
 * would post under the user's name with no one acknowledging the risk, so they stay off and the
 * variable is reported instead of silently ignored.
 */
export function envWarnings(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith('LURK_REPLY') && read(env, name) !== undefined)
    .sort()
    .map((name) => `${name} is not supported: automatic replies need their risk acknowledged in the UI or with lurk run --reply --i-understand-auto-reply-risk, so they stay off`);
}

export interface ServeEnv {
  token: string | undefined;
  proxy: string | undefined;
}

/**
 * Listening beyond loopback needs a strong LURK_TOKEN; on loopback a missing token is
 * generated per start by the caller.
 */
export function serveEnv(host: string, env: Env): ServeEnv {
  checkCredentialsEnv(env);
  // LURK_TOKEN_FILE (a Docker secret, for one) wins over LURK_TOKEN.
  const file = read(env, 'LURK_TOKEN_FILE');
  const token = file === undefined ? read(env, 'LURK_TOKEN') : readTokenFile(file);
  const loopback = host === 'localhost' || isLoopback(host);
  if (!loopback && token === undefined) {
    throw new EnvError(`--host ${host} accepts remote connections, so LURK_TOKEN is required (at least ${MIN_TOKEN_BYTES} random bytes, e.g. \`openssl rand -base64 48\`)`);
  }
  if (token !== undefined && !tokenStrongEnough(token)) throw new EnvError(`LURK_TOKEN must be ${TOKEN_REQUIREMENT} (e.g. \`openssl rand -base64 48\`)`);
  return { token, proxy: proxyFromEnv(env) };
}

function readTokenFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch (err) {
    throw new EnvError(`LURK_TOKEN_FILE ${path} cannot be read: ${(err as Error).message}`);
  }
}

/** The schedule and preset id the environment defines; kept apart from user-made schedules. */
export const ENV_SCHEDULE_ID = 'env';

function windowFromEnv(env: Env): string {
  const v = read(env, 'LURK_WINDOW') ?? '07:00-23:00';
  if (!/^(\d{2}:\d{2})-(\d{2}:\d{2})$/.test(v)) throw new EnvError(`LURK_WINDOW must be HH:MM-HH:MM, not "${v}"`);
  return v;
}

/**
 * The unattended schedule `lurk serve` runs when LURK_RUNS_PER_DAY is set above zero, as the
 * `lurk schedule add` command line that defines it: a random daily window for Profile
 * `<LURK_SITE>/default`, headless, with the preset the variables describe. Each variable is
 * checked here so an error names it; the command line itself is parsed by `schedule add`.
 */
export function envScheduleArgv(env: Env, defaultTimezone: string): string[] | null {
  const runs = wholeNumber(env, 'LURK_RUNS_PER_DAY');
  if (runs === undefined || runs === 0) return null;
  const argv = [
    '--id', ENV_SCHEDULE_ID,
    '--name', 'LURK_* environment',
    '--site', siteFromEnv(env).id,
    '--profile', 'default',
    '--runs', String(runs),
    '--window', windowFromEnv(env),
    '--jitter', String(wholeNumber(env, 'LURK_JITTER_MIN') ?? 15),
    // Gaps of an hour keep the day's runs from bunching up; a narrow window gets as many as fit.
    '--min-gap', '60',
    '--timezone', read(env, 'TZ') ?? defaultTimezone,
    '--misfire', 'skip',
    '--grace', '30',
  ];
  if (bool(env, 'LURK_RUN_ON_START') ?? true) argv.push('--run-on-start');
  const browseMode = browseModeFromEnv(env);
  if (browseMode) argv.push('--browse-mode', browseMode);
  if (runModeFromEnv(env)) argv.push('--run-mode', read(env, 'LURK_RUN_MODE')!);
  const categories = categoryTokens(env);
  if (categories) argv.push('--categories', categories.join(','));
  if (bool(env, 'LURK_LIKE')) argv.push('--like');
  const likeRate = percent(env, 'LURK_LIKE_RATE');
  if (likeRate !== undefined) argv.push('--like-rate', String(likeRate));
  return argv;
}
