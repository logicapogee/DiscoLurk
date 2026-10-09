import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { systemSleeper, type CategoryStore, type Clock, type InterruptibleSleeper, type ProfileHealth, type ProfileId, type RunCoordinator, type RunEvent, type Site, type StopRequest } from '@disco-lurk/core';
import type { ScheduleBook } from '@disco-lurk/config';
import type { ServerInfo, Settings, UpdateInfo } from './contract';
import { EventHub, HttpError } from './hub';
import { LoginManager } from './logins';
import { ok, type AppContext } from './routes/context';
import { diagnosticRoutes } from './routes/diagnostics';
import { profileRoutes } from './routes/profiles';
import { runRoutes } from './routes/runs';
import { scheduleRoutes } from './routes/schedules';
import { ProfileGate, RunManager, SiteCatalog, type Notify } from './runs';
import { ScheduleService } from './schedules';
import { parseBody, settingsPatchSchema } from './schemas';
import type { Route } from './server';
import { PresetStore, ProfileRegistry, RunHistory, SettingsStore, splitProfileId, type LockHolder } from './store';

export { defaultPreset } from './routes/runs';

/** Messages to the desktop shell, which owns the tray and native notifications. */
export interface ShellChannel {
  notify(title: string, body: string): void;
  token(token: string): void;
  activeRuns(count: number): void;
}

export interface LatestRelease {
  tag: string;
  url: string;
}

export interface AppDeps {
  version: string;
  clock: Clock;
  /** Paces the schedule loop; the system sleeper unless a test drives time. */
  sleeper?: InterruptibleSleeper;
  /** `<appData>/disco-lurk`: presets, settings, Profile metadata, run history and schedules live here. */
  dataDir: string;
  profilesDir: string;
  coordinator: RunCoordinator;
  sites: readonly Site[];
  categories: CategoryStore;
  lockHolder: LockHolder;
  doctor(): Promise<unknown>;
  /** Shuts the whole process down; the app's own close() is one of the cleanups it runs. */
  shutdown(): Promise<void>;
  /** False where a headed browser has nowhere to show (a headless server). */
  displayAvailable(): boolean;
  /** Runs started here are forced headless and headed sign-in is refused. */
  headlessOnly?: boolean;
  shell?: ShellChannel;
  latestRelease?(): Promise<LatestRelease | null>;
  releasePage?: string;
  newSeed?(): number;
  log?(message: string): void;
  /** Schedules from outside `schedules.json`, such as `lurk serve`'s LURK_* schedule. */
  extraSchedules?(): Promise<ScheduleBook>;
  scheduleIntervalMs?: number;
  /** Whether the process that marked a run open still lives; tests stand in a dead one. */
  processAlive?(pid: number): boolean;
}

export interface LurkApp {
  routes: Route[];
  hub: EventHub;
  /** Loads stored state, takes charge of the schedules and starts planning them. */
  start(): Promise<void>;
  /** Rotation needs the server, which is created from these routes. */
  bindTokenRotation(rotate: (token: string) => void): void;
  /** Stops every run as an app exit, closes sign-in windows and waits for records to be written. */
  close(reason?: StopRequest): Promise<void>;
  /** Exposed for tests. */
  services: { runs: RunManager; logins: LoginManager; schedules: ScheduleService; presets: PresetStore; settings: SettingsStore; profiles: ProfileRegistry; catalog: SiteCatalog };
}

/** `1.2.3` style versions, a leading `v` allowed; anything unparsable never counts as newer. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return false;
}

const EVENT_TYPES: ReadonlySet<RunEvent['type']> = new Set(['state', 'topic', 'floor', 'action', 'timings', 'stats', 'levels', 'warning', 'error']);

export function createApp(deps: AppDeps): LurkApp {
  const log = deps.log ?? (() => {});
  const hub = new EventHub();
  const gate = new ProfileGate();
  const settings = new SettingsStore(join(deps.dataDir, 'settings.json'));
  const presets = new PresetStore(join(deps.dataDir, 'presets.json'));
  const history = new RunHistory(join(deps.dataDir, 'runs'), () => settings.get().historyLimit, log);
  const catalog = new SiteCatalog(deps.sites, (site) =>
    site.categorySource === 'builtin' ? Promise.resolve(site.builtinCategories ?? []) : deps.categories.load(site.id),
  );
  const profiles = new ProfileRegistry(
    join(deps.dataDir, 'profiles.json'),
    deps.profilesDir,
    join(deps.dataDir, 'backups'),
    () => catalog.sites.map((s) => s.id),
    deps.lockHolder,
  );
  const notify: Notify = (kind, title, body) => {
    const s = settings.get();
    if (!s.notifications || (kind === 'run-started' && !s.notifyOnStart)) return;
    deps.shell?.notify(title, body);
  };
  const runs = new RunManager({
    coordinator: deps.coordinator,
    catalog,
    history,
    hub,
    gate,
    clock: deps.clock,
    newSeed: deps.newSeed ?? (() => randomInt(0, 2 ** 31)),
    notify,
    onActiveChange: (n) => deps.shell?.activeRuns(n),
    log,
  });
  const publishProfiles = async () => hub.publish({ type: 'profiles-changed', profiles: await profiles.list((id) => gate.isBusy(id)) });
  const recordHealth = async (health: ProfileHealth) => {
    await profiles.setHealth(health);
    const { siteId } = splitProfileId(health.profileId);
    await catalog.refresh(siteId).catch((err: unknown) => log(`category reload for ${siteId} failed: ${String(err)}`));
  };
  const logins = new LoginManager({
    coordinator: deps.coordinator,
    gate,
    hub,
    clock: deps.clock,
    afterSignIn: async (health) => {
      await recordHealth(health);
      await publishProfiles();
    },
  });
  const schedules = new ScheduleService({
    clock: deps.clock,
    sleeper: deps.sleeper ?? systemSleeper,
    dataDir: deps.dataDir,
    presets,
    catalog,
    runs,
    gate,
    hub,
    notify,
    lockedElsewhere: async (id) => (await deps.lockHolder(profiles.dirOf(id))) !== null,
    displayAvailable: () => !deps.headlessOnly && deps.displayAvailable(),
    log,
    ...(deps.extraSchedules ? { extraSchedules: deps.extraSchedules } : {}),
    ...(deps.scheduleIntervalMs !== undefined ? { intervalMs: deps.scheduleIntervalMs } : {}),
  });
  let rotate: ((token: string) => void) | null = null;

  const requireProfile = async (id: ProfileId) => {
    if (!(await profiles.exists(id))) throw new HttpError(404, 'unknown-profile', `Unknown Profile ${id}`);
  };
  const requireFree = async (id: ProfileId) => {
    if (gate.isBusy(id)) throw new HttpError(409, 'profile-busy', `Profile ${id} is in use`);
    const holder = await deps.lockHolder(profiles.dirOf(id));
    if (holder !== null) throw new HttpError(409, 'profile-locked', `Profile ${id} is held by PID ${holder}`);
  };
  const ctx: AppContext = {
    clock: deps.clock,
    dataDir: deps.dataDir,
    headlessOnly: deps.headlessOnly === true,
    log,
    hub,
    gate,
    settings,
    presets,
    history,
    catalog,
    profiles,
    runs,
    logins,
    schedules,
    async withProfile(params) {
      const id = `${params.site}/${params.name}`;
      splitProfileId(id);
      await requireProfile(id);
      return id;
    },
    requireProfile,
    requireFree,
    async inspect(id) {
      await requireProfile(id);
      await requireFree(id);
      const release = gate.claim(id, 'health check');
      try {
        const health = await deps.coordinator.inspect(id);
        await recordHealth(health);
        return health;
      } finally {
        release();
        await publishProfiles();
      }
    },
    recordHealth,
    publishProfiles,
    async startPreset(presetId) {
      const preset = presets.get(presetId);
      if (!preset) throw new HttpError(404, 'unknown-preset', `Unknown preset ${presetId}`);
      if (!preset.profileId) throw new HttpError(422, 'no-profile', '先为该预设选择一个 Profile');
      await requireProfile(preset.profileId);
      await requireFree(preset.profileId);
      const run = runs.startPreset(deps.headlessOnly ? { ...preset, browserMode: 'headless' } : preset);
      if (settings.get().currentPresetId !== presetId) {
        const next = await settings.update({ currentPresetId: presetId });
        hub.publish({ type: 'settings', settings: next });
      }
      return run;
    },
    async runLog(runId, types) {
      if (!runs.get(runId) && !history.get(runId)) throw new HttpError(404, 'unknown-run', `Unknown run ${runId}`);
      const wanted = types?.filter((t): t is RunEvent['type'] => EVENT_TYPES.has(t as RunEvent['type']));
      const { events, skipped } = await history.readEvents(runId);
      if (skipped > 0) log(`run ${runId}: skipped ${skipped} unreadable event line(s)`);
      return { events: events.filter((e) => !wanted?.length || wanted.includes(e.type)), skipped };
    },
  };

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/shutdown',
      handle: async () => ({ status: 202, body: { status: 'shutting-down' }, after: () => deps.shutdown() }),
    },
    { method: 'GET', path: '/doctor', handle: async () => ok(await deps.doctor()) },
    {
      method: 'GET',
      path: '/info',
      handle: async () => ok({ version: deps.version, headlessOnly: deps.headlessOnly === true, platform: process.platform } satisfies ServerInfo),
    },
    ...diagnosticRoutes(ctx, deps.doctor),
    ...profileRoutes(ctx),
    ...runRoutes(ctx),
    ...scheduleRoutes(ctx),
    { method: 'GET', path: '/settings', handle: async () => ok(settings.get()) },
    {
      method: 'PUT',
      path: '/settings',
      handle: async ({ body }) => {
        const next = await settings.update(parseBody(settingsPatchSchema, body) as Partial<Settings>);
        hub.publish({ type: 'settings', settings: next });
        return ok(next);
      },
    },
    {
      method: 'POST',
      path: '/token/rotate',
      handle: async () => {
        if (!rotate) throw new HttpError(503, 'not-ready');
        const token = randomBytes(32).toString('base64url');
        const apply = rotate;
        // Answered with the old token still valid; every socket drops right after.
        return { status: 200, body: { token }, after: () => { apply(token); deps.shell?.token(token); } };
      },
    },
    {
      method: 'GET',
      path: '/update-check',
      handle: async () => {
        const releaseUrl = deps.releasePage ?? '';
        const none: UpdateInfo = { current: deps.version, latest: null, newer: false, releaseUrl };
        if (!settings.get().updateCheck || !deps.latestRelease) return ok(none);
        // A failed check is not an error for the UI: it simply shows no update.
        const latest = await deps.latestRelease().catch((err: unknown) => {
          log(`update check failed: ${String(err)}`);
          return null;
        });
        if (!latest) return ok(none);
        return ok({ current: deps.version, latest: latest.tag, newer: isNewer(latest.tag, deps.version), releaseUrl: latest.url } satisfies UpdateInfo);
      },
    },
  ];

  return {
    routes,
    hub,
    services: { runs, logins, schedules, presets, settings, profiles, catalog },
    async start() {
      await Promise.all([settings.load(), presets.load(), history.load(), profiles.load()]);
      const lost = await history.recoverOpen(new Date(deps.clock.now()).toISOString(), deps.processAlive);
      if (lost > 0) log(`history: ${lost} run(s) were in progress when the previous sidecar stopped; recorded as failed`);
      await catalog.refreshAll().catch((err: unknown) => log(`category load failed: ${String(err)}`));
      await schedules.start();
    },
    bindTokenRotation(fn) {
      rotate = fn;
    },
    async close(reason = 'app-exit') {
      await schedules.stop();
      runs.stopAll(reason);
      await Promise.all([runs.settle(), logins.closeAll()]);
      // Released after the runs ended, so the scheduler has recorded how each one finished.
      await schedules.close();
    },
  };
}
