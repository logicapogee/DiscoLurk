import { execFile } from 'node:child_process';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FileCategoryStore } from '@disco-lurk/config';
import { DiscoLurkCoordinator, RunError, systemClock, systemDeps, type CoordinatorEnv, type Site } from '@disco-lurk/core';
import { createApp, startServer, type AppDeps, type LatestRelease, type LurkApp, type LurkServer, type ShellChannel } from '@disco-lurk/server';
import { LOCK_FILE, openDiscourseForum, processAlive, readLock, type Credentials } from '@disco-lurk/site-discourse';
import { runDoctor } from './doctor';
import type { SidecarLifecycle } from './lifecycle';
import { BUILTIN_SITES, findSite } from './sites';

const execFileAsync = promisify(execFile);

export const RELEASES_API = 'https://api.github.com/repos/logicapogee/DiscoLurk/releases/latest';
export const RELEASES_PAGE = 'https://github.com/logicapogee/DiscoLurk/releases';

export interface SidecarAppOptions {
  version: string;
  dataDir: string;
  /** Docker and other displayless hosts: every run is headless and headed sign-in is refused. */
  headlessOnly: boolean;
  shell?: ShellChannel;
  credentials?: (site: Site) => Credentials | undefined;
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
      return openDiscourseForum({
        site: req.site,
        profileDir: app!.services.profiles.dirOf(req.profile.id),
        runId: req.runId,
        channel: req.profile.channel,
        headless: req.browserMode === 'headless',
        deps,
        warn: req.warn,
        ...(req.profile.executablePath ? { executablePath: req.profile.executablePath } : {}),
        ...(req.profile.proxy ? { proxy: req.profile.proxy } : {}),
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
    displayAvailable: () => !opts.headlessOnly,
    latestRelease,
    releasePage: RELEASES_PAGE,
    log: opts.log,
    ...(opts.shell ? { shell: opts.shell } : {}),
  };
  app = createApp(appDeps);
  return { app, exit };
}

/**
 * Lines for the desktop shell on the sidecar's own stdout, which only the shell reads. The shell
 * owns the tray and native notifications, and keeps working while the window's page is suspended.
 */
export function stdoutShell(write: (line: string) => void = (l) => process.stdout.write(l + '\n')): ShellChannel {
  return {
    notify: (title, body) => write(JSON.stringify({ event: 'notify', title, body })),
    settings: (s) => write(JSON.stringify({ event: 'settings', closeToTray: s.closeToTray })),
    token: (token) => write(JSON.stringify({ event: 'token', token })),
    activeRuns: (count) => write(JSON.stringify({ event: 'runs', active: count })),
  };
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
  log(message: string): void;
}

/**
 * Reclaims Profiles a dead sidecar left locked, then serves the API. Shutdown, from any trigger,
 * stops runs as an app exit, closes sign-in windows and waits for history to be written.
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
  });
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
  // Registered first so it runs last: the server keeps answering /health while runs wind down.
  opts.lifecycle.register('server', () => listening.close());
  opts.lifecycle.register('runs and sign-in windows', async () => {
    exit.abort();
    await app.close('app-exit');
  });
  return listening;
}
