import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ScheduleBook } from '@disco-lurk/config';
import { TAURI_ORIGINS, type ServerFrame } from '@disco-lurk/server';
import { envSchedule, envWarnings, proxyFromEnv, serveEnv, siteFromEnv } from './env';
import { SidecarLifecycle } from './lifecycle';
import { appDataDir } from './paths';
import { credentialsFromEnv, EXIT, resolveCategories, UsageError } from './run';
import { CategoryCache, systemTimezone } from './schedule';
import { bootServer } from './sidecar';

export interface ServeArgs {
  host: string;
  port: number;
  headless: boolean;
  origins: string[];
  uiDir: string | undefined;
  dataDir: string;
}

/** The built UI ships inside the binary next to the bundle; `--ui` or `LURK_UI_DIR` point elsewhere. */
function defaultUiDir(): string | undefined {
  const bundled = join(__dirname, 'ui');
  return existsSync(join(bundled, 'index.html')) ? bundled : undefined;
}

export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '8080' },
        headless: { type: 'boolean', default: false },
        origin: { type: 'string', multiple: true },
        ui: { type: 'string' },
        data: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) throw new UsageError(`Invalid --port ${values.port}`);
  const ui = values.ui ?? env.LURK_UI_DIR;
  const data = values.data ?? env.LURK_DATA_DIR;
  return {
    host: values.host,
    port,
    headless: values.headless,
    origins: values.origin ?? [],
    uiDir: ui ? resolve(ui) : defaultUiDir(),
    dataDir: data ? resolve(data) : appDataDir(),
  };
}

/**
 * The token for `serve`: `LURK_TOKEN` when set. Without it only a loopback listener may start, and
 * it mints a token of its own and prints it once, since there is no shell to hand it to.
 */
export function serveToken(host: string, env: NodeJS.ProcessEnv): { token: string; minted: boolean } {
  const given = serveEnv(host, env).token;
  return given !== undefined ? { token: given, minted: false } : { token: randomBytes(32).toString('base64url'), minted: true };
}

/**
 * The LURK_* schedule as a definition the scheduler reads beside `schedules.json`; its categories
 * are resolved against the site's list on every read, as that list can change after a sign-in.
 */
export function envSchedules(env: NodeJS.ProcessEnv, dataDir: string): (() => Promise<ScheduleBook>) | undefined {
  const fromEnv = envSchedule(env, systemTimezone());
  if (!fromEnv) return undefined;
  const site = siteFromEnv(env);
  const categories = new CategoryCache(join(dataDir, 'sites'));
  return async () => {
    await categories.refresh([site.id]);
    const preset = { ...fromEnv.preset, categoryPaths: resolveCategories(site, categories.known(site.id), fromEnv.categoryTokens).map((c) => c.path) };
    return { schedules: [fromEnv.spec], presets: [preset] };
  };
}

/** What a host without a screen keeps of a run: its warnings, errors and how it ended. */
export function runLogLine(frame: ServerFrame): string | null {
  if (frame.type === 'event') {
    const e = frame.event;
    if (e.type === 'warning') return `${frame.runId} warning ${e.code}: ${e.message}`;
    if (e.type === 'error') return `${frame.runId} error ${e.error.code}: ${e.error.message}`;
    return null;
  }
  if (frame.type === 'run') {
    const { run } = frame;
    if (!run.result) return run.state === 'queued' ? `run ${run.runId} (${run.presetName}) for ${run.plan.profileId}` : null;
    const r = run.result;
    const c = r.stats.confirmed;
    return `run ${run.runId} ended: ${r.outcome} (${r.stopCause})${r.failure ? ` ${r.failure.code}` : ''}, confirmed ${c.topics} topics / ${c.floors} floors`;
  }
  return null;
}

/** The server, its web UI and the schedules in one process, for a NAS, Docker or a remote desktop. */
export async function serve(argv: string[], version: string): Promise<number> {
  const args = parseServeArgs(argv);
  const { token, minted } = serveToken(args.host, process.env);
  const proxy = proxyFromEnv(process.env);
  const extraSchedules = envSchedules(process.env, args.dataDir);
  const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
  for (const w of envWarnings(process.env)) log(`warning: ${w}`);
  const lifecycle = new SidecarLifecycle(log);
  const server = await bootServer({
    version,
    host: args.host,
    port: args.port,
    token,
    dataDir: args.dataDir,
    headlessOnly: args.headless,
    lifecycle,
    // The served UI is same-origin; extra origins are for a UI hosted elsewhere, such as behind a proxy.
    allowedOrigins: [...TAURI_ORIGINS, ...args.origins],
    credentials: (site) => credentialsFromEnv(site),
    ...(proxy ? { proxy } : {}),
    onFrame: (frame) => {
      const line = runLogLine(frame);
      if (line) log(line);
    },
    log,
    ...(extraSchedules ? { extraSchedules } : {}),
    ...(args.uiDir ? { staticDir: args.uiDir } : {}),
  });
  const shown = args.host.includes(':') ? `[${args.host}]` : args.host;
  log(`lurk serve ${version} listening on http://${shown}:${server.port}${args.headless ? ' (headless)' : ''}`);
  log(args.uiDir ? `UI: ${args.uiDir}` : 'UI: not bundled; API only (pass --ui <dir>)');
  log(`Data: ${args.dataDir}`);
  if (extraSchedules) log('LURK_* schedule: planned as schedule "env" beside the ones in schedules.json');
  if (minted) log(`Token (this run only; set LURK_TOKEN to keep one): ${token}`);
  process.once('SIGTERM', () => void lifecycle.shutdown('SIGTERM'));
  process.once('SIGINT', () => void lifecycle.shutdown('SIGINT'));
  await lifecycle.done;
  return EXIT.ok;
}
