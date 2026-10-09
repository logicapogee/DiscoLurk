import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { FileCategoryStore, type ScheduleBook } from '@disco-lurk/config';
import { DiscoLurkCoordinator, RunError, systemClock, systemDeps, type CoordinatorEnv, type Site } from '@disco-lurk/core';
import { createApp, startServer, type AppDeps, type LatestRelease, type LurkApp, type LurkServer, type ServerFrame, type ShellChannel } from '@disco-lurk/server';
import { LOCK_FILE, openDiscourseForum, processAlive, readLock, type Credentials } from '@disco-lurk/site-discourse';
import { runDoctor } from './doctor';
import { SidecarLifecycle } from './lifecycle';
import { DailyLog } from './log-file';
import { appDataDir } from './paths';
import { EXIT } from './run';
import { BUILTIN_SITES, findSite } from './sites';

const execFileAsync = promisify(execFile);

export const RELEASES_API = 'https://api.github.com/repos/logicapogee/DiscoLurk/releases/latest';
export const RELEASES_PAGE = 'https://github.com/logicapogee/DiscoLurk/releases';

/** A Linux session without X11 or Wayland cannot show a headed browser; other desktops always have one. */
export function hasDisplay(platform = process.platform, env = process.env): boolean {
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export interface SidecarAppOptions {
  version: string;
  dataDir: string;
  /** Docker and other displayless hosts: every run is headless and headed sign-in is refused. */
  headlessOnly: boolean;
  shell?: ShellChannel;
  credentials?: (site: Site) => Credentials | undefined;
  /** LURK_PROXY: used by every Profile that has no proxy of its own. */
  proxy?: string;
  /** `lurk serve`'s LURK_* schedule, planned beside the ones in `schedules.json`. */
  extraSchedules?(): Promise<ScheduleBook>;
  log(message: string): void;
  /** Filled in once the server listens, so doctor reports the live port. */
  listeningPort(): number | undefined;
  shutdown(): Promise<void>;
}

export interface SidecarApp {
  app: LurkApp;
  /** Aborted on exit: it cuts a run's final progress read short. */
  exit: AbortController;
}

const lockHolder = async (profileDir: string): Promise<number | null> => {
  const lock = await readLock(join(profileDir, LOCK_FILE));
  return lock && lock.pid !== process.pid && processAlive(lock.pid) ? lock.pid : null;
};

/** Chrome receives its Profile as `--user-data-dir=<dir>`, which is how its processes are found. */
async function browserPidsUsing(profileDir: string): Promise<number[]> {
  const flag = `--user-data-dir=${profileDir}`;
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return parsePids(stdout, '\t', flag);
  }
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 });
  return parsePids(stdout, ' ', flag);
}

function parsePids(table: string, sep: string, flag: string): number[] {
  return table
    .split('\n')
    .map((line) => line.trim())
    // The flag must end where an argument ends, so `/p/a` never matches the sibling `/p/ab`.
    .filter((line) => line.endsWith(flag) || line.includes(`${flag} `))
    .map((line) => Number(line.slice(0, line.indexOf(sep))))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * A sidecar that died left its Profile locks behind, and possibly the Chrome processes it had
 * started. Before serving anything, each lock whose owner is gone has its browsers terminated and
 * is then removed, so the first run on that Profile starts clean.
 */
export async function reclaimProfiles(profilesDir: string, siteIds: readonly string[], log: (m: string) => void): Promise<void> {
  for (const siteId of siteIds) {
    const entries = await readdir(join(profilesDir, siteId), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const dir = join(profilesDir, siteId, entry.name);
      const lockPath = join(dir, LOCK_FILE);
      const lock = await readLock(lockPath);
      if (!lock || processAlive(lock.pid)) continue;
      const pids = await browserPidsUsing(dir).catch((err: unknown) => {
        log(`reclaim: cannot list processes for ${dir}: ${String(err)}`);
        return [];
      });
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      await unlink(lockPath).catch(() => {});
      log(`reclaim: released ${siteId}/${entry.name} from dead PID ${lock.pid}${pids.length ? `, killed browsers ${pids.join(', ')}` : ''}`);
    }
  }
}

async function latestRelease(): Promise<LatestRelease | null> {
  const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  return typeof body.tag_name === 'string' ? { tag: body.tag_name, url: typeof body.html_url === 'string' ? body.html_url : RELEASES_PAGE } : null;
}

/** The server app over the real kernel: Playwright-backed Profiles under `<dataDir>/profiles`. */
export function createSidecarApp(opts: SidecarAppOptions): SidecarApp {
  const profilesDir = join(opts.dataDir, 'profiles');
  const sitesDir = join(opts.dataDir, 'sites');
  const exit = new AbortController();
  const deps = systemDeps();
  const categories = new FileCategoryStore(sitesDir);
  let app: LurkApp | undefined;

  const env: CoordinatorEnv = {
    deps,
    categories,
    exitSignal: exit.signal,
    async resolveProfile(profileId) {
      const profile = await app!.services.profiles.resolve(profileId);
      const site = findSite(profile.siteId);
      if (!site) throw new RunError('internal', `Unknown site ${profile.siteId}`);
      return { profile, site };
    },
    async open(req) {
      if (opts.headlessOnly && req.browserMode === 'headed') {
        throw new RunError('browser-missing', 'This server has no display; headed browsers are unavailable');
      }
      const credentials = opts.credentials?.(req.site);
      const proxy = req.profile.proxy ?? opts.proxy;
      return openDiscourseForum({
        site: req.site,
        profileDir: app!.services.profiles.dirOf(req.profile.id),
        runId: req.runId,
        channel: req.profile.channel,
        headless: req.browserMode === 'headless',
        deps,
        warn: req.warn,
        ...(proxy ? { proxy } : {}),
        ...(credentials ? { credentials } : {}),
      });
    },
  };

  const appDeps: AppDeps = {
    version: opts.version,
    clock: systemClock,
    dataDir: opts.dataDir,
    profilesDir,
    coordinator: new DiscoLurkCoordinator(env),
    sites: BUILTIN_SITES,
    categories,
    lockHolder,
    headlessOnly: opts.headlessOnly,
    doctor: () => {
      const port = opts.listeningPort();
      return runDoctor({ version: opts.version, profilesDir, ...(port !== undefined ? { listeningPort: port } : {}) });
    },
    shutdown: opts.shutdown,
    displayAvailable: () => !opts.headlessOnly && hasDisplay(),
    latestRelease,
    releasePage: RELEASES_PAGE,
    log: opts.log,
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.extraSchedules ? { extraSchedules: opts.extraSchedules } : {}),
  };
  app = createApp(appDeps);
  return { app, exit };
}

/** Lines the sidecar writes to its stdout, which only the desktop shell reads. */
export type SidecarLine =
  | { event: 'starting' }
  | { event: 'ready'; port: number; token: string; version: string }
  | { event: 'alive' }
  | { event: 'runs'; active: number }
  | { event: 'token'; token: string }
  | { event: 'notify'; title: string; body: string }
  | { event: 'result'; cmd: ShellCommand; ok: boolean; message?: string };

/** Tray actions the shell writes to the sidecar's stdin, one JSON object per line. */
export type ShellCommand = 'start' | 'stop' | 'shutdown';

export const ALIVE_INTERVAL_MS = 10_000;

export const stdoutLine = (line: SidecarLine) => process.stdout.write(JSON.stringify(line) + '\n');

/**
 * The shell owns the tray and native notifications and keeps working while the window's page is
 * suspended, so the server reaches it through stdout rather than the page.
 */
export function stdoutShell(write: (line: SidecarLine) => void = stdoutLine): ShellChannel {
  return {
    notify: (title, body) => write({ event: 'notify', title, body }),
    // Closing the window always hides it to the tray, so the shell has no setting to follow.
    settings: () => {},
    token: (token) => write({ event: 'token', token }),
    activeRuns: (count) => write({ event: 'runs', active: count }),
  };
}

export function parseShellCommand(line: string): ShellCommand | null {
  try {
    const cmd = (JSON.parse(line) as { cmd?: unknown } | null)?.cmd;
    return cmd === 'start' || cmd === 'stop' || cmd === 'shutdown' ? cmd : null;
  } catch {
    return null;
  }
}

/** The REST routes the tray's start and stop stand for, so both paths behave the same. */
const COMMAND_ROUTES = { start: '/runs/current', stop: '/runs/stop' } as const;

async function runRoute(app: LurkApp, path: string): Promise<void> {
  const route = app.routes.find((r) => r.method === 'POST' && r.path === path);
  if (!route) throw new Error(`no route POST ${path}`);
  await route.handle({ params: {}, query: new URLSearchParams(), body: undefined, ip: '127.0.0.1' });
}

/**
 * Serves the shell's stdin commands. Every command is answered with a `result` line; `shutdown`
 * is answered before the cleanup starts, since the shell watches for the exit itself.
 */
export function serveShellCommands(opts: {
  input: Readable;
  app: LurkApp;
  lifecycle: SidecarLifecycle;
  write: (line: SidecarLine) => void;
  log(message: string): void;
}): void {
  const lines = createInterface({ input: opts.input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const cmd = parseShellCommand(line);
    if (cmd === null) {
      opts.log(`stdin: ignored ${JSON.stringify(line.slice(0, 200))}`);
      return;
    }
    if (cmd === 'shutdown') {
      opts.write({ event: 'result', cmd, ok: true });
      void opts.lifecycle.shutdown('shutdown command');
      return;
    }
    runRoute(opts.app, COMMAND_ROUTES[cmd]).then(
      () => opts.write({ event: 'result', cmd, ok: true }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        opts.log(`stdin: ${cmd} failed: ${message}`);
        opts.write({ event: 'result', cmd, ok: false, message });
      },
    );
  });
}

export interface BootOptions {
  version: string;
  host: string;
  port: number;
  token: string;
  dataDir: string;
  headlessOnly: boolean;
  lifecycle: SidecarLifecycle;
  allowedOrigins?: readonly string[];
  staticDir?: string;
  shell?: ShellChannel;
  credentials?: (site: Site) => Credentials | undefined;
  proxy?: string;
  extraSchedules?(): Promise<ScheduleBook>;
  /** Every frame the server pushes to its clients; `lurk serve` logs runs from them. */
  onFrame?(frame: ServerFrame): void;
  /** The desktop shell's stdin and the stdout line writer that answers it. */
  shellCommands?: { input: Readable; write: (line: SidecarLine) => void };
  log(message: string): void;
}

/**
 * Reclaims Profiles a dead sidecar left locked, then serves the API and runs the schedules.
 * Shutdown, from any trigger, stops planning, stops runs as an app exit, closes sign-in windows,
 * waits for history to be written and then releases the schedule lock.
 */
export async function bootServer(opts: BootOptions): Promise<LurkServer> {
  await reclaimProfiles(join(opts.dataDir, 'profiles'), BUILTIN_SITES.map((s) => s.id), opts.log);
  let server: LurkServer | undefined;
  const { app, exit } = createSidecarApp({
    version: opts.version,
    dataDir: opts.dataDir,
    headlessOnly: opts.headlessOnly,
    log: opts.log,
    listeningPort: () => server?.port,
    shutdown: () => opts.lifecycle.shutdown('/shutdown request'),
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    ...(opts.extraSchedules ? { extraSchedules: opts.extraSchedules } : {}),
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  if (opts.onFrame) app.hub.subscribe(opts.onFrame);
  await app.start();
  server = await startServer({
    host: opts.host,
    port: opts.port,
    token: opts.token,
    version: opts.version,
    clock: systemClock,
    routes: app.routes,
    hub: app.hub,
    log: opts.log,
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
  });
  const listening = server;
  app.bindTokenRotation((token) => listening.rotateToken(token));
  if (opts.shellCommands) serveShellCommands({ ...opts.shellCommands, app, lifecycle: opts.lifecycle, log: opts.log });
  // Registered first so it runs last: the server keeps answering /health while runs wind down.
  opts.lifecycle.register('server', () => listening.close());
  opts.lifecycle.register('runs and sign-in windows', async () => {
    exit.abort();
    await app.close('app-exit');
  });
  return listening;
}

/**
 * `lurk sidecar`, spawned by the desktop shell. It binds 127.0.0.1:0 and mints its token itself,
 * announcing both in the ready line: the token never appears in argv, the environment or a file,
 * where other local processes could read it.
 */
export async function runSidecar(argv: string[], version: string): Promise<number> {
  if (argv.length > 0) {
    console.error('sidecar takes no arguments');
    return EXIT.environment;
  }
  const token = randomBytes(32).toString('base64url');
  // Once the shell is gone its ends of stdout/stderr are closed; dropping those write errors keeps
  // them from crashing the sidecar before cleanup finishes.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const dataDir = appDataDir();
  const file = new DailyLog(join(dataDir, 'logs'));
  // stderr feeds the shell's start-up failure page; the file is the lasting record.
  const log = (m: string) => {
    file.write(m);
    console.error(m);
  };
  const lifecycle = new SidecarLifecycle(log);
  // Reclaiming Profiles a dead sidecar left behind can take a while; this tells the shell the
  // process is up and working towards ready.
  stdoutLine({ event: 'starting' });
  log(`sidecar ${version} starting, pid ${process.pid}`);
  const server = await bootServer({
    version,
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    headlessOnly: false,
    lifecycle,
    shell: stdoutShell(),
    shellCommands: { input: process.stdin, write: stdoutLine },
    log,
  });
  stdoutLine({ event: 'ready', port: server.port, token, version });
  log(`sidecar ready on 127.0.0.1:${server.port}`);
  // stdin stays paused until here, so an EOF during start-up is seen once the cleanups exist.
  lifecycle.watchParent(process.stdin);
  process.once('SIGTERM', () => void lifecycle.shutdown('SIGTERM'));
  process.once('SIGINT', () => void lifecycle.shutdown('SIGINT'));
  const alive = setInterval(() => stdoutLine({ event: 'alive' }), ALIVE_INTERVAL_MS);
  alive.unref();
  await lifecycle.done;
  clearInterval(alive);
  return EXIT.ok;
}
