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
  type RunResult,
  type Site,
  type StopRequest,
} from '@disco-lurk/core';
import type { ActiveRun, RunRecord, StoredPreset } from './contract';
import { EventHub, HttpError } from './server';
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

  constructor(
    readonly sites: readonly Site[],
    private readonly load: (site: Site) => Promise<Category[]>,
  ) {}

  site(siteId: string): Site {
    const site = this.sites.find((s) => s.id === siteId);
    if (!site) throw new HttpError(404, 'unknown-site', `Unknown site ${siteId}`);
    return site;
  }

  categories(siteId: string): Category[] {
    return structuredClone(this.cache.get(siteId) ?? []);
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
export type Notify = (kind: 'run-completed' | 'run-failed' | 'needs-login', title: string, body: string) => void;

export interface RunManagerDeps {
  coordinator: RunCoordinator;
  catalog: SiteCatalog;
  history: RunHistory;
  hub: EventHub;
  gate: ProfileGate;
  clock: Clock;
  newSeed(): number;
  notify: Notify;
  onActiveChange?(count: number): void;
}

interface Live {
  view: ActiveRun;
  controller: AbortController;
  done: Promise<void>;
}

const NEEDS_LOGIN_STATES = new Set(['awaiting_login', 'needs_auth']);

export function planFor(preset: StoredPreset, categories: readonly Category[], seed: number, nowMs: number): RunPlanSnapshot {
  if (!preset.profileId) throw new HttpError(422, 'no-profile', `Preset ${preset.id} has no Profile`);
  const at = new Date(nowMs).toISOString();
  return {
    id: `run-${nowMs}-${seed.toString(16)}`,
    siteId: preset.siteId,
    profileId: preset.profileId,
    browserMode: preset.browserMode,
    preset: resolvePreset(preset, categories, seededRandom(seed)),
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

  busyProfiles(): ProfileId[] {
    return [...this.live.values()].map((l) => l.view.plan.profileId);
  }

  startPreset(preset: StoredPreset): ActiveRun {
    const plan = planFor(preset, this.deps.catalog.categories(preset.siteId), this.deps.newSeed(), this.deps.clock.now());
    return this.launch(plan, preset.name);
  }

  /** Starts a fixed snapshot; the scheduler calls this with snapshots it materialized earlier. */
  launch(plan: RunPlanSnapshot, presetName: string): ActiveRun {
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
    const emit = (event: RunEvent) => {
      if (event.type === 'state') {
        view.state = event.state;
        if (NEEDS_LOGIN_STATES.has(event.state) && !askedToSignIn) {
          askedToSignIn = true;
          this.deps.notify('needs-login', '需要登录', `${presetName}：请在浏览器窗口中登录，或在 Profile 页重新登录`);
        }
      }
      void this.deps.history.appendEvent(plan.id, JSON.stringify(event));
      this.deps.hub.publish({ type: 'event', runId: plan.id, event });
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
        await this.deps.history.add(record);
      } finally {
        this.live.delete(plan.id);
        release();
        this.deps.hub.publish({ type: 'run', run: structuredClone(view) });
        this.deps.onActiveChange?.(this.live.size);
        this.announce(presetName, result);
      }
    };
    const done = this.deps.coordinator.run(plan, controller.signal, emit).then(finish, (err: unknown) =>
      // The coordinator turns every run failure into a result; reaching here is a bug worth a record.
      finish({ outcome: 'failed', stopCause: 'error', stats: emptyStats(), failure: toFailure(err), baseline: 'missing', levels: { initial: null, final: null } }),
    );
    void this.deps.history.markOpen({ runId: plan.id, presetId: view.presetId, presetName, plan: view.plan, startedAt: view.startedAt });
    this.live.set(plan.id, { view, controller, done });
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
