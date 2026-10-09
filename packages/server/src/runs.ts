import {
  resolvePreset,
  seededRandom,
  stopRequest,
  toFailure,
  emptyStats,
  type Category,
  type Clock,
  type ProfileId,
  type RunCoordinator,
  type RunEvent,
  type RunPlanSnapshot,
  type RunPreset,
  type RunResult,
  type Site,
  type StopRequest,
} from '@disco-lurk/core';
import type { ActiveRun, LoggedEvent, RunRecord, StoredPreset } from './contract';
import { EventHub, HttpError } from './hub';
import type { RunHistory } from './store';

/**
 * One holder per Profile at a time across runs, sign-ins and health checks; a second claim is a
 * 409 at once rather than a run that fails later on the Profile lock.
 */
export class ProfileGate {
  private held = new Map<ProfileId, string>();

  isBusy(profileId: ProfileId): boolean {
    return this.held.has(profileId);
  }

  claim(profileId: ProfileId, owner: string): () => void {
    const holder = this.held.get(profileId);
    if (holder) throw new HttpError(409, 'profile-busy', `Profile ${profileId} is in use (${holder})`);
    this.held.set(profileId, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(profileId);
    };
  }
}

/** The site's categories as last loaded; a discovered site's list changes after each sign-in. */
export class SiteCatalog {
  private cache = new Map<string, Category[]>();
  private list: Site[];

  constructor(
    sites: readonly Site[],
    private readonly load: (site: Site) => Promise<Category[]>,
  ) {
    this.list = [...sites];
  }

  get sites(): readonly Site[] {
    return this.list;
  }

  /** Adds a site the user configured; a built-in site keeps its id. */
  add(site: Site): void {
    if (this.list.some((s) => s.id === site.id)) throw new HttpError(409, 'site-exists', `Site ${site.id} already exists`);
    this.list = [...this.list, site];
  }

  site(siteId: string): Site {
    const site = this.sites.find((s) => s.id === siteId);
    if (!site) throw new HttpError(404, 'unknown-site', `Unknown site ${siteId}`);
    return site;
  }

  categories(siteId: string): Category[] {
    return structuredClone(this.cache.get(siteId) ?? []);
  }

  /**
   * The site's categories plus any path the preset names that the list does not know yet: a
   * discovered site can run a preset made before its first discovery, as on the command line.
   */
  categoriesFor(preset: Pick<RunPreset, 'siteId' | 'categoryPaths'>): Category[] {
    const known = this.categories(preset.siteId);
    const extra = preset.categoryPaths.flatMap((path): Category[] => {
      if (known.some((c) => c.path === path)) return [];
      const m = /^\/c\/(?:[^\s]+\/)?([^/\s]+)\/(\d+)$/.exec(path);
      return m ? [{ name: m[1]!, path, id: Number(m[2]), enabledByDefault: true }] : [];
    });
    return [...known, ...extra];
  }

  async refresh(siteId: string): Promise<Category[]> {
    this.cache.set(siteId, await this.load(this.site(siteId)));
    return this.categories(siteId);
  }

  async refreshAll(): Promise<void> {
    for (const s of this.sites) await this.refresh(s.id);
  }
}

/** The shell side of notifications; absent outside the desktop sidecar. */
type NotifyKind = 'run-started' | 'run-completed' | 'run-failed' | 'needs-login' | 'run-skipped';
export type Notify = (kind: NotifyKind, title: string, body: string) => void;

interface RunManagerDeps {
  coordinator: RunCoordinator;
  catalog: SiteCatalog;
  history: RunHistory;
  hub: EventHub;
  gate: ProfileGate;
  clock: Clock;
  newSeed(): number;
  notify: Notify;
  onActiveChange?(count: number): void;
  log?(message: string): void;
}

interface Live {
  view: ActiveRun;
  controller: AbortController;
  done: Promise<void>;
}

const NEEDS_LOGIN_STATES = new Set(['awaiting_login', 'needs_auth']);

/** `warn` hears what the kernel turned off, such as replies whose risk was not acknowledged. */
export function planFor(preset: StoredPreset, categories: readonly Category[], seed: number, nowMs: number, warn?: (code: string, message: string) => void): RunPlanSnapshot {
  if (!preset.profileId) throw new HttpError(422, 'no-profile', `Preset ${preset.id} has no Profile`);
  const at = new Date(nowMs).toISOString();
  return {
    id: `run-${nowMs}-${seed.toString(16)}`,
    siteId: preset.siteId,
    profileId: preset.profileId,
    browserMode: preset.browserMode,
    preset: resolvePreset(preset, categories, seededRandom(seed), warn),
    seed,
    plannedAt: at,
    materializedAt: at,
  };
}

export class RunManager {
  private live = new Map<string, Live>();

  constructor(private readonly deps: RunManagerDeps) {}

  active(): ActiveRun[] {
    return [...this.live.values()].map((l) => structuredClone(l.view));
  }

  get(runId: string): ActiveRun | undefined {
    const l = this.live.get(runId);
    return l ? structuredClone(l.view) : undefined;
  }

  startPreset(preset: StoredPreset): ActiveRun {
    const plan = planFor(preset, this.deps.catalog.categoriesFor(preset), this.deps.newSeed(), this.deps.clock.now(), (code, message) =>
      this.deps.log?.(`preset ${preset.id}: ${code}: ${message}`),
    );
    return this.launch(plan, preset.name);
  }

  /**
   * Starts a fixed snapshot; the scheduler calls this with snapshots it materialized earlier and
   * hears through `onEnded` how each ended, once its record is written.
   */
  launch(plan: RunPlanSnapshot, presetName: string, onEnded?: (result: RunResult) => Promise<void>): ActiveRun {
    if (this.live.has(plan.id)) throw new HttpError(409, 'run-exists', `Run ${plan.id} is already running`);
    const release = this.deps.gate.claim(plan.profileId, `run ${plan.id}`);
    const controller = new AbortController();
    const view: ActiveRun = {
      runId: plan.id,
      presetId: plan.preset.presetId,
      presetName,
      plan: structuredClone(plan),
      startedAt: new Date(this.deps.clock.now()).toISOString(),
      state: 'queued',
      stopping: false,
    };
    let askedToSignIn = false;
    let seq = 0;
    const runIdJson = JSON.stringify(plan.id);
    const emit = (event: RunEvent) => {
      const logged: LoggedEvent = { seq: ++seq, ...event };
      const line = JSON.stringify(logged);
      this.deps.history.appendEvent(plan.id, line);
      this.deps.hub.publish({ type: 'event', runId: plan.id, event: logged }, `{"type":"event","runId":${runIdJson},"event":${line}}`);
      // The run's state reaches clients only through `run` frames; the UI never derives it from events.
      if (event.type === 'state') {
        view.state = event.state;
        this.deps.hub.publish({ type: 'run', run: structuredClone(view) });
        if (NEEDS_LOGIN_STATES.has(event.state) && !askedToSignIn) {
          askedToSignIn = true;
          this.deps.notify('needs-login', '需要登录', `${presetName}：请在浏览器窗口中登录，或在 Profile 页重新登录`);
        }
      }
    };
    const finish = async (result: RunResult) => {
      view.result = result;
      view.state = result.outcome;
      const record: RunRecord = {
        runId: plan.id,
        presetId: view.presetId,
        presetName,
        plan: view.plan,
        startedAt: view.startedAt,
        endedAt: new Date(this.deps.clock.now()).toISOString(),
        result,
      };
      try {
        await this.deps.history.closeRun(plan.id);
        await this.deps.history.add(record);
      } catch (err) {
        this.deps.log?.(`run ${plan.id}: writing its record failed: ${String(err)}`);
      } finally {
        this.live.delete(plan.id);
        release();
        this.deps.hub.publish({ type: 'run', run: structuredClone(view), record });
        this.deps.onActiveChange?.(this.live.size);
        this.announce(presetName, result);
      }
      await onEnded?.(result).catch((err: unknown) => this.deps.log?.(`run ${plan.id}: recording its end for the scheduler failed: ${String(err)}`));
    };
    this.deps.history.openRun({ runId: plan.id, presetId: view.presetId, presetName, plan: view.plan, startedAt: view.startedAt });
    const done = this.deps.coordinator.run(plan, controller.signal, emit).then(finish, (err: unknown) =>
      // The coordinator turns every run failure into a result; reaching here is a bug worth a record.
      finish({ outcome: 'failed', stopCause: 'error', stats: emptyStats(), failure: toFailure(err), baseline: 'missing', levels: { initial: null, final: null } }),
    );
    this.live.set(plan.id, { view, controller, done });
    this.deps.notify('run-started', '开始运行', `${presetName}：${plan.profileId} · ${plan.browserMode === 'headless' ? '无头' : '有头'}`);
    this.deps.hub.publish({ type: 'run', run: structuredClone(view) });
    this.deps.onActiveChange?.(this.live.size);
    return structuredClone(view);
  }

  private announce(presetName: string, result: RunResult) {
    const c = result.stats.confirmed;
    if (result.failure?.code === 'needs-auth' || result.failure?.code === 'challenge-detected') return;
    if (result.outcome === 'failed') {
      this.deps.notify('run-failed', '运行失败', `${presetName}：${result.failure?.code ?? 'internal'} ${result.failure?.message ?? ''}`.trim());
    } else {
      this.deps.notify('run-completed', '运行结束', `${presetName}：已确认 ${c.topics} 个话题、${c.floors} 层楼`);
    }
  }

  stop(runId: string, reason: StopRequest = 'user'): ActiveRun {
    const l = this.live.get(runId);
    if (!l) throw new HttpError(404, 'unknown-run', `Run ${runId} is not running`);
    l.view.stopping = true;
    l.controller.abort(stopRequest(reason));
    this.deps.hub.publish({ type: 'run', run: structuredClone(l.view) });
    return structuredClone(l.view);
  }

  stopAll(reason: StopRequest): number {
    const ids = [...this.live.keys()];
    for (const id of ids) this.stop(id, reason);
    return ids.length;
  }

  /** Resolves once every run has ended and its record is written. */
  async settle(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => l.done));
    await this.deps.history.flush();
  }
}
