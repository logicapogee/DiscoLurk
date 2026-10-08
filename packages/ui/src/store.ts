import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { RunEvent } from '@disco-lurk/core';
import type { ActiveRun, LoginView, ProfileView, RunRecord, ServerFrame, ServerInfo, Settings, SiteView, StoredPreset, UpdateInfo } from '@disco-lurk/server/contract';
import { Api, EventStream, type StreamStatus } from './api';

/** The log keeps the newest events of a run; a long endless run would otherwise grow without bound. */
const MAX_EVENTS = 5000;

export interface State {
  info: ServerInfo;
  stream: StreamStatus;
  sites: SiteView[];
  profiles: ProfileView[];
  presets: StoredPreset[];
  settings: Settings;
  /** Running runs, plus finished ones until the page moves on, so their result stays on screen. */
  runs: Record<string, ActiveRun>;
  events: Record<string, RunEvent[]>;
  logins: Record<string, LoginView>;
  history: RunRecord[];
  update: UpdateInfo | null;
}

export class Store {
  state: State;
  private listeners = new Set<() => void>();
  private stream: EventStream | null = null;

  constructor(
    readonly api: Api,
    initial: State,
  ) {
    this.state = initial;
  }

  static async load(api: Api): Promise<Store> {
    const [info, sites, profiles, presets, settings, active, logins, history] = await Promise.all([
      api.info(),
      api.sites(),
      api.profiles(),
      api.presets(),
      api.settings(),
      api.activeRuns(),
      api.logins(),
      api.history(),
    ]);
    const store = new Store(api, {
      info,
      stream: 'connecting',
      sites,
      profiles,
      presets,
      settings,
      runs: Object.fromEntries(active.map((r) => [r.runId, r])),
      events: {},
      logins: Object.fromEntries(logins.map((l) => [l.profileId, l])),
      history,
      update: null,
    });
    await Promise.all(active.map((r) => store.backfill(r.runId)));
    return store;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  connect(onAuthFailed: () => void) {
    this.stream = new EventStream(
      this.api,
      (f) => this.apply(f),
      (s) => {
        this.set({ stream: s });
        if (s === 'auth-failed') onAuthFailed();
        // Whatever happened while the socket was down is read back once it is up again.
        if (s === 'open') void this.resync();
      },
    );
    this.stream.start();
  }

  disconnect() {
    this.stream?.stop();
  }

  reconnectStream() {
    this.stream?.reconnectNow();
  }

  /** Merges the stored event log with events that already arrived live, without doubling any. */
  async backfill(runId: string) {
    const stored = await this.api.runEvents(runId).catch(() => [] as RunEvent[]);
    const seen = new Set(stored.map((e) => JSON.stringify(e)));
    const live = (this.state.events[runId] ?? []).filter((e) => !seen.has(JSON.stringify(e)));
    this.set({ events: { ...this.state.events, [runId]: [...stored, ...live].slice(-MAX_EVENTS) } });
  }

  async resync() {
    const [active, profiles, logins, history] = await Promise.all([this.api.activeRuns(), this.api.profiles(), this.api.logins(), this.api.history()]).catch(
      () => [null, null, null, null] as const,
    );
    if (!active || !profiles || !logins || !history) return;
    const finished = Object.fromEntries(Object.entries(this.state.runs).filter(([, r]) => r.result));
    this.set({
      runs: { ...finished, ...Object.fromEntries(active.map((r) => [r.runId, r])) },
      profiles,
      logins: Object.fromEntries(logins.map((l) => [l.profileId, l])),
      history,
    });
    await Promise.all(active.map((r) => this.backfill(r.runId)));
  }

  refreshProfiles = async () => this.set({ profiles: await this.api.profiles() });
  refreshPresets = async () => this.set({ presets: await this.api.presets() });
  refreshSites = async () => this.set({ sites: await this.api.sites() });
  refreshHistory = async () => this.set({ history: await this.api.history() });

  /** A refresh a frame prompted; if it fails, the next reconnect's resync reads the state again. */
  private background(p: Promise<unknown>) {
    p.catch(() => {});
  }

  apply(f: ServerFrame) {
    switch (f.type) {
      case 'event': {
        const list = this.state.events[f.runId] ?? [];
        const next = list.length >= MAX_EVENTS ? [...list.slice(1 - MAX_EVENTS), f.event] : [...list, f.event];
        const run = this.state.runs[f.runId];
        const runs = run && f.event.type === 'state' ? { ...this.state.runs, [f.runId]: { ...run, state: f.event.state } } : this.state.runs;
        this.set({ events: { ...this.state.events, [f.runId]: next }, runs });
        return;
      }
      case 'run':
        this.set({ runs: { ...this.state.runs, [f.run.runId]: f.run } });
        if (f.run.result) {
          this.background(this.refreshHistory());
          this.background(this.refreshProfiles());
        }
        return;
      case 'login':
        this.set({ logins: { ...this.state.logins, [f.login.profileId]: f.login } });
        if (['done', 'failed', 'closed'].includes(f.login.phase)) this.background(this.refreshProfiles());
        return;
      case 'profiles-changed':
        this.background(this.refreshProfiles());
        this.background(this.refreshSites());
        return;
      case 'settings':
        this.set({ settings: f.settings });
        return;
      case 'auth-ok':
      case 'heartbeat':
        return;
    }
  }
}

export const StoreContext = createContext<Store | null>(null);

/** Re-renders the caller on every store change; the state is small enough for that. */
export function useStore(): [State, Store] {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreContext');
  const [, tick] = useState(0);
  useEffect(() => store.subscribe(() => tick((n) => n + 1)), [store]);
  return [store.state, store];
}
