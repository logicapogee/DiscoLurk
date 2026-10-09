import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { RunResult, RunStats } from '@disco-lurk/core';
import type {
  ActiveRun,
  LoggedEvent,
  LoginView,
  ProfileView,
  RunRecord,
  ScheduleList,
  ServerFrame,
  ServerInfo,
  Settings,
  SiteView,
  StoredPreset,
  UpdateInfo,
} from '@disco-lurk/server/contract';
import { Api, EventStream, type StreamStatus } from './api';

/** The log keeps the newest events of a run; a long endless run would otherwise grow without bound. */
const MAX_EVENTS = 5000;
/** A finished run's events stay in memory this long; its history entry reads them back on demand. */
export const FINISHED_EVENTS_TTL_MS = 10 * 60_000;

/** What the run's events said last, kept as they arrive instead of rescanning the log. */
export interface LiveRun {
  stats?: RunStats;
  levels: RunResult['levels'];
}

export interface State {
  info: ServerInfo;
  stream: StreamStatus;
  sites: SiteView[];
  profiles: ProfileView[];
  presets: StoredPreset[];
  settings: Settings;
  /** Running runs, plus finished ones until the page moves on, so their result stays on screen. */
  runs: Record<string, ActiveRun>;
  events: Record<string, LoggedEvent[]>;
  live: Record<string, LiveRun>;
  logins: Record<string, LoginView>;
  history: RunRecord[];
  schedules: ScheduleList;
  update: UpdateInfo | null;
}

const emptyLive = (): LiveRun => ({ levels: { initial: null, final: null } });

/** Folds events into the run's latest stats and progress reads; a later read of a kind replaces the earlier one. */
function fold(live: LiveRun, events: readonly LoggedEvent[]): LiveRun {
  let next = live;
  for (const e of events) {
    if (e.type === 'stats') next = { ...next, stats: e.stats };
    else if (e.type === 'levels') next = { ...next, levels: { ...next.levels, [e.kind]: e.snapshot } };
  }
  return next;
}

export class Store {
  state: State;
  private listeners = new Set<() => void>();
  private stream: EventStream | null = null;
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly api: Api,
    initial: State,
  ) {
    this.state = initial;
  }

  static async load(api: Api): Promise<Store> {
    const [info, sites, profiles, presets, settings, active, logins, history, schedules] = await Promise.all([
      api.info(),
      api.sites(),
      api.profiles(),
      api.presets(),
      api.settings(),
      api.activeRuns(),
      api.logins(),
      api.history(),
      api.schedules(),
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
      live: {},
      logins: Object.fromEntries(logins.map((l) => [l.profileId, l])),
      history,
      schedules,
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

  /** Merges the stored event log with events that already arrived live; `seq` tells them apart. */
  async backfill(runId: string) {
    const stored = await this.api.runEvents(runId).catch(() => [] as LoggedEvent[]);
    const upTo = stored.at(-1)?.seq ?? 0;
    const live = (this.state.events[runId] ?? []).filter((e) => e.seq > upTo);
    const merged = [...stored, ...live].slice(-MAX_EVENTS);
    this.set({ events: { ...this.state.events, [runId]: merged }, live: { ...this.state.live, [runId]: fold(emptyLive(), merged) } });
  }

  /** Drops a finished run's events after a while, so a long session does not keep every log. */
  private expireEvents(runId: string) {
    if (this.expiry.has(runId)) return;
    this.expiry.set(
      runId,
      setTimeout(() => {
        this.expiry.delete(runId);
        const { [runId]: _dropped, ...events } = this.state.events;
        this.set({ events });
      }, FINISHED_EVENTS_TTL_MS),
    );
  }

  async resync() {
    const [active, profiles, logins, history, schedules] = await Promise.all([
      this.api.activeRuns(),
      this.api.profiles(),
      this.api.logins(),
      this.api.history(),
      this.api.schedules(),
    ]).catch(() => [null, null, null, null, null] as const);
    if (!active || !profiles || !logins || !history || !schedules) return;
    const finished = Object.fromEntries(Object.entries(this.state.runs).filter(([, r]) => r.result));
    this.set({
      runs: { ...finished, ...Object.fromEntries(active.map((r) => [r.runId, r])) },
      profiles,
      logins: Object.fromEntries(logins.map((l) => [l.profileId, l])),
      history,
      schedules,
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
        // A frame that arrived during a backfill is already in the stored log.
        if (f.event.seq <= (list.at(-1)?.seq ?? 0)) return;
        const next = list.length >= MAX_EVENTS ? [...list.slice(1 - MAX_EVENTS), f.event] : [...list, f.event];
        const patch: Partial<State> = { events: { ...this.state.events, [f.runId]: next } };
        if (f.event.type === 'stats' || f.event.type === 'levels') patch.live = { ...this.state.live, [f.runId]: fold(this.state.live[f.runId] ?? emptyLive(), [f.event]) };
        this.set(patch);
        return;
      }
      case 'run': {
        const patch: Partial<State> = { runs: { ...this.state.runs, [f.run.runId]: f.run } };
        if (f.record) {
          patch.history = [f.record, ...this.state.history.filter((r) => r.runId !== f.record!.runId)];
          this.expireEvents(f.run.runId);
        }
        this.set(patch);
        return;
      }
      case 'login':
        this.set({ logins: { ...this.state.logins, [f.login.profileId]: f.login } });
        return;
      case 'profiles-changed':
        this.set({ profiles: f.profiles });
        // A health check may have read a discovered site's categories.
        this.background(this.refreshSites());
        return;
      case 'schedules':
        this.set({ schedules: f.list });
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

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Re-renders the caller when the part of the state `select` picks changes (compared shallowly);
 * without a selector, on every change.
 */
export function useStore(): [State, Store];
export function useStore<T>(select: (s: State) => T): [T, Store];
export function useStore<T>(select?: (s: State) => T): [T | State, Store] {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreContext');
  const [, tick] = useState(0);
  // The latest selector, so a subscription made on mount still reads what the caller asks for now.
  const selector = useRef(select);
  selector.current = select;
  const pick = (s: State) => (selector.current ? selector.current(s) : s);
  const last = useRef<T | State>(pick(store.state));
  last.current = pick(store.state);
  useEffect(
    () =>
      store.subscribe(() => {
        const next = pick(store.state);
        if (shallowEqual(next, last.current)) return;
        last.current = next;
        tick((n) => n + 1);
      }),
    [store],
  );
  return [last.current, store];
}
