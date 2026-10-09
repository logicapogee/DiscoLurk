import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { systemSleeper, type Category, type CategoryStore, type Clock, type InterruptibleSleeper, type ProfileId, type RunCoordinator, type RunEvent, type Site, type StopRequest } from '@disco-lurk/core';
import type { ScheduleBook } from '@disco-lurk/config';
import type { PresetSave, ProfileCreate, ProfilePatch, ServerInfo, Settings, SiteView, StoredPreset, UpdateInfo } from './contract';
import { LoginManager } from './logins';
import { ProfileGate, RunManager, SiteCatalog, type Notify } from './runs';
import { ScheduleService } from './schedules';
import { parseBody, presetSaveSchema, profileCreateSchema, profilePatchSchema, scheduleSpecSchema, settingsPatchSchema } from './schemas';
import { EventHub, HttpError, type Reply, type Route } from './server';
import { HISTORY_LIMIT, PresetStore, ProfileRegistry, RunHistory, SettingsStore, splitProfileId, toJsonl, type LockHolder } from './store';

/** Messages to the desktop shell, which owns the tray and native notifications. */
export interface ShellChannel {
  notify(title: string, body: string): void;
  settings(settings: Settings): void;
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
  services: { runs: RunManager; logins: LoginManager; schedules: ScheduleService; presets: PresetStore; settings: SettingsStore; profiles: ProfileRegistry };
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });

/** Built-in run defaults: deep, endless, likes and replies off, 1–3 s extra wait, 3–8 topics per category. */
export function defaultPreset(site: Site, categories: readonly Category[]): StoredPreset {
  return {
    id: `${site.id}-default`,
    name: `${site.displayName} 默认`,
    siteId: site.id,
    profileId: null,
    browserMode: 'headed',
    browseMode: 'deep',
    runMode: { kind: 'endless' },
    categoryPaths: categories.filter((c) => c.enabledByDefault).map((c) => c.path),
    interaction: {
      like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
      reply: { enabled: false, rate: 5, riskAcknowledged: false },
    },
    extraWait: { enabled: true, minSec: 1, maxSec: 3 },
    samplePerCategory: { min: 3, max: 8 },
  };
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
  const history = new RunHistory(join(deps.dataDir, 'runs'), HISTORY_LIMIT, log);
  const catalog = new SiteCatalog(deps.sites, (site) =>
    site.categorySource === 'builtin' ? Promise.resolve(site.builtinCategories ?? []) : deps.categories.load(site.id),
  );
  const profiles = new ProfileRegistry(
    join(deps.dataDir, 'profiles.json'),
    deps.profilesDir,
    join(deps.dataDir, 'backups'),
    () => deps.sites.map((s) => s.id),
    deps.lockHolder,
  );
  const notify: Notify = (_kind, title, body) => {
    if (settings.get().notifications) deps.shell?.notify(title, body);
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
  const afterHealth = async (health: Parameters<ProfileRegistry['setHealth']>[0]) => {
    await profiles.setHealth(health);
    const { siteId } = splitProfileId(health.profileId);
    await catalog.refresh(siteId).catch((err: unknown) => log(`category reload for ${siteId} failed: ${String(err)}`));
    hub.publish({ type: 'profiles-changed' });
  };
  const logins = new LoginManager({ coordinator: deps.coordinator, gate, hub, clock: deps.clock, afterSignIn: afterHealth });
  const schedules = new ScheduleService({
    clock: deps.clock,
    sleeper: deps.sleeper ?? systemSleeper,
    dataDir: deps.dataDir,
    presets,
    catalog,
    runs,
    gate,
    displayAvailable: () => !deps.headlessOnly && deps.displayAvailable(),
    log,
    ...(deps.extraSchedules ? { extraSchedules: deps.extraSchedules } : {}),
    ...(deps.scheduleIntervalMs !== undefined ? { intervalMs: deps.scheduleIntervalMs } : {}),
  });
  let rotate: ((token: string) => void) | null = null;

  const profileIdOf = (p: Record<string, string>): ProfileId => {
    const id = `${p.site}/${p.name}`;
    splitProfileId(id);
    return id;
  };
  const requireProfile = async (id: ProfileId) => {
    if (!(await profiles.exists(id))) throw new HttpError(404, 'unknown-profile', `Unknown Profile ${id}`);
  };
  /** A lock held by another process (a CLI run) is a conflict now, not a failed run later. */
  const requireFree = async (id: ProfileId) => {
    if (gate.isBusy(id)) throw new HttpError(409, 'profile-busy', `Profile ${id} is in use`);
    const holder = await deps.lockHolder(profiles.dirOf(id));
    if (holder !== null) throw new HttpError(409, 'profile-locked', `Profile ${id} is held by PID ${holder}`);
  };
  const inspect = async (id: ProfileId) => {
    await requireProfile(id);
    await requireFree(id);
    const release = gate.claim(id, 'health check');
    hub.publish({ type: 'profiles-changed' });
    try {
      const health = await deps.coordinator.inspect(id);
      await afterHealth(health);
      return health;
    } finally {
      release();
      hub.publish({ type: 'profiles-changed' });
    }
  };
  /** The run's stored events, optionally only some types; lines a crash cut short are skipped and logged. */
  const runLog = async (runId: string, types: readonly string[] | null) => {
    if (!runs.get(runId) && !history.get(runId)) throw new HttpError(404, 'unknown-run', `Unknown run ${runId}`);
    const wanted = types?.filter((t): t is RunEvent['type'] => EVENT_TYPES.has(t as RunEvent['type']));
    const { events, skipped } = await history.readEvents(runId);
    if (skipped > 0) log(`run ${runId}: skipped ${skipped} unreadable event line(s)`);
    return { events: events.filter((e) => !wanted?.length || wanted.includes(e.type)), skipped };
  };
  const startPreset = async (presetId: string) => {
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

    {
      method: 'GET',
      path: '/sites',
      handle: async () => ok(deps.sites.map((site): SiteView => ({ site, categories: catalog.categories(site.id) }))),
    },
    {
      method: 'GET',
      path: '/sites/:site/categories',
      handle: async ({ params }) => ok(await catalog.refresh(catalog.site(params.site!).id)),
    },
    {
      // Categories of a discovered site are read by a signed-in health check of one of its Profiles.
      method: 'POST',
      path: '/sites/:site/categories/refresh',
      handle: async ({ params, body }) => {
        const site = catalog.site(params.site!);
        const profileId = (body as { profileId?: unknown } | undefined)?.profileId;
        if (typeof profileId !== 'string' || splitProfileId(profileId).siteId !== site.id) {
          throw new HttpError(422, 'invalid-body', 'profileId of this site is required');
        }
        const health = await inspect(profileId);
        return ok({ health, categories: catalog.categories(site.id) });
      },
    },
    {
      method: 'GET',
      path: '/sites/:site/default-preset',
      handle: async ({ params }) => {
        const site = catalog.site(params.site!);
        return ok(defaultPreset(site, catalog.categories(site.id)));
      },
    },

    { method: 'GET', path: '/profiles', handle: async () => ok(await profiles.list((id) => gate.isBusy(id))) },
    {
      method: 'POST',
      path: '/profiles',
      handle: async ({ body }) => {
        const req: ProfileCreate = parseBody(profileCreateSchema, body);
        catalog.site(req.siteId);
        await profiles.create(req);
        hub.publish({ type: 'profiles-changed' });
        return ok({ id: `${req.siteId}/${req.name}` }, 201);
      },
    },
    {
      method: 'PATCH',
      path: '/profiles/:site/:name',
      handle: async ({ params, body }) => {
        const id = profileIdOf(params);
        await requireProfile(id);
        const patch: ProfilePatch = parseBody(profilePatchSchema, body);
        await profiles.patch(id, patch);
        hub.publish({ type: 'profiles-changed' });
        return ok({ id });
      },
    },
    {
      method: 'DELETE',
      path: '/profiles/:site/:name',
      handle: async ({ params }) => {
        const id = profileIdOf(params);
        await requireProfile(id);
        await requireFree(id);
        await profiles.remove(id);
        hub.publish({ type: 'profiles-changed' });
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/profiles/:site/:name/backup',
      handle: async ({ params }) => {
        const id = profileIdOf(params);
        await requireProfile(id);
        await requireFree(id);
        const stamp = new Date(deps.clock.now()).toISOString().replace(/[:.]/g, '-');
        return ok({ path: await profiles.backup(id, stamp) });
      },
    },
    { method: 'POST', path: '/profiles/:site/:name/inspect', handle: async ({ params }) => ok(await inspect(profileIdOf(params))) },

    { method: 'GET', path: '/logins', handle: async () => ok(logins.list()) },
    {
      method: 'POST',
      path: '/profiles/:site/:name/login',
      handle: async ({ params }) => {
        const id = profileIdOf(params);
        if (deps.headlessOnly) throw new HttpError(422, 'no-display', '此服务器没有图形界面，无法打开有头登录窗口');
        await requireProfile(id);
        const current = logins.get(id);
        if (!current || ['done', 'failed', 'closed'].includes(current.phase)) await requireFree(id);
        return ok(logins.start(id), 202);
      },
    },
    { method: 'POST', path: '/profiles/:site/:name/login/recheck', handle: async ({ params }) => ok(logins.recheck(profileIdOf(params)), 202) },
    { method: 'POST', path: '/profiles/:site/:name/login/continue', handle: async ({ params }) => ok(logins.continue(profileIdOf(params)), 202) },
    { method: 'POST', path: '/profiles/:site/:name/login/close', handle: async ({ params }) => ok(await logins.close(profileIdOf(params))) },

    { method: 'GET', path: '/presets', handle: async () => ok(presets.list()) },
    {
      method: 'PUT',
      path: '/presets/:id',
      handle: async ({ params, body }) => {
        const save: PresetSave = parseBody(presetSaveSchema, body);
        if (save.preset.id !== params.id) throw new HttpError(422, 'id-mismatch', 'The preset id must match the URL');
        catalog.site(save.preset.siteId);
        const stored = presets.get(save.preset.id);
        if (stored && stored.siteId !== save.preset.siteId) {
          const users = await schedules.usersOf(save.preset.id);
          if (users.length > 0) throw new HttpError(409, 'preset-in-use', `Preset ${save.preset.id} is run by schedule ${users.join(', ')}; its site cannot change`);
        }
        // Automatic replies post under the user's name; the kernel also turns them off without this.
        const reply = save.preset.interaction.reply;
        if (reply.enabled && !reply.riskAcknowledged) throw new HttpError(428, 'reply-confirmation-required', '开启自动回复需要确认风险');
        await presets.put(save.preset);
        await schedules.presetSaved(save.preset);
        return ok(save.preset);
      },
    },
    {
      method: 'DELETE',
      path: '/presets/:id',
      handle: async ({ params }) => {
        const users = await schedules.usersOf(params.id!);
        if (users.length > 0) throw new HttpError(409, 'preset-in-use', `Preset ${params.id} is run by schedule ${users.join(', ')}`);
        if (!(await presets.remove(params.id!))) throw new HttpError(404, 'unknown-preset', `Unknown preset ${params.id}`);
        return { status: 204 };
      },
    },

    { method: 'GET', path: '/runs/active', handle: async () => ok(runs.active()) },
    {
      method: 'POST',
      path: '/runs',
      handle: async ({ body }) => {
        const presetId = (body as { presetId?: unknown } | undefined)?.presetId;
        if (typeof presetId !== 'string') throw new HttpError(422, 'invalid-body', 'presetId is required');
        return ok(await startPreset(presetId), 202);
      },
    },
    {
      // The tray's start entry: the preset last started from the UI.
      method: 'POST',
      path: '/runs/current',
      handle: async () => {
        const id = settings.get().currentPresetId;
        if (!id) throw new HttpError(409, 'no-current-preset', '尚未从界面开始过任何预设');
        return ok(await startPreset(id), 202);
      },
    },
    { method: 'POST', path: '/runs/stop', handle: async () => ok({ stopped: runs.stopAll('user') }) },
    { method: 'POST', path: '/runs/:id/stop', handle: async ({ params }) => ok(runs.stop(params.id!)) },
    {
      method: 'GET',
      path: '/runs/history',
      handle: async ({ query }) => {
        const n = Number(query.get('limit') ?? '50');
        return ok(history.list(Number.isInteger(n) && n > 0 ? n : 50));
      },
    },
    {
      method: 'GET',
      path: '/runs/:id',
      handle: async ({ params }) => {
        const found = runs.get(params.id!) ?? history.get(params.id!);
        if (!found) throw new HttpError(404, 'unknown-run', `Unknown run ${params.id}`);
        return ok(found);
      },
    },
    {
      method: 'GET',
      path: '/runs/:id/events',
      handle: async ({ params }) => {
        const { events, skipped } = await runLog(params.id!, null);
        return { status: 200, body: events, headers: { 'X-Skipped-Lines': String(skipped) } };
      },
    },
    {
      // The event log as JSONL, optionally only some event types; `types=state,warning,error`.
      method: 'GET',
      path: '/runs/:id/log',
      handle: async ({ params, query }) => {
        const id = params.id!;
        const { events, skipped } = await runLog(id, query.get('types')?.split(',') ?? null);
        return {
          status: 200,
          text: toJsonl(events),
          contentType: 'application/x-ndjson; charset=utf-8',
          headers: { 'Content-Disposition': `attachment; filename="${id}.jsonl"`, 'X-Skipped-Lines': String(skipped) },
        };
      },
    },
    {
      // The desktop webview has no download manager, so the shell's UI asks for a file on disk instead.
      method: 'POST',
      path: '/runs/:id/export',
      handle: async ({ params, body }) => {
        const id = params.id!;
        const types = (body as { types?: unknown } | undefined)?.types;
        const { events, skipped } = await runLog(id, Array.isArray(types) ? types.filter((t) => typeof t === 'string') : null);
        const stamp = new Date(deps.clock.now()).toISOString().replace(/[:.]/g, '-');
        const path = join(deps.dataDir, 'exports', `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}.jsonl`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, toJsonl(events));
        return ok({ path, lines: events.length, skipped });
      },
    },

    { method: 'GET', path: '/settings', handle: async () => ok(settings.get()) },
    {
      method: 'PUT',
      path: '/settings',
      handle: async ({ body }) => {
        const next = await settings.update(parseBody(settingsPatchSchema, body) as Partial<Settings>);
        deps.shell?.settings(next);
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

    { method: 'GET', path: '/schedules', handle: async () => ok(schedules.list()) },
    {
      method: 'PUT',
      path: '/schedules/:id',
      handle: async ({ params, body }) => {
        const spec = parseBody(scheduleSpecSchema, body);
        if (spec.id !== params.id) throw new HttpError(422, 'id-mismatch', 'The schedule id must match the URL');
        await requireProfile(spec.profileId);
        return ok(await schedules.upsert(spec));
      },
    },
    { method: 'DELETE', path: '/schedules/:id', handle: async ({ params }) => ok(await schedules.remove(params.id!)) },
    { method: 'POST', path: '/schedules/:id/trigger', handle: async ({ params }) => ok({ runId: await schedules.trigger(params.id!) }, 202) },
    { method: 'POST', path: '/schedules/:id/pause', handle: async ({ params }) => ok(await schedules.pause(params.id!)) },
    { method: 'POST', path: '/schedules/:id/resume', handle: async ({ params }) => ok(await schedules.resume(params.id!)) },
    { method: 'GET', path: '/schedules/:id/history', handle: async ({ params }) => ok(schedules.history(params.id!)) },
  ];

  return {
    routes,
    hub,
    services: { runs, logins, schedules, presets, settings, profiles },
    async start() {
      await Promise.all([settings.load(), presets.load(), history.load(), profiles.load()]);
      const lost = await history.recoverOpen(new Date(deps.clock.now()).toISOString(), deps.processAlive);
      if (lost > 0) log(`history: ${lost} run(s) were in progress when the previous sidecar stopped; recorded as failed`);
      await catalog.refreshAll().catch((err: unknown) => log(`category load failed: ${String(err)}`));
      deps.shell?.settings(settings.get());
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
