// @vitest-environment happy-dom
import { emptyStats, EXPERIMENTS_OFF, type Category, type LevelSnapshot, type RunPlanSnapshot, type RunStats } from '@disco-lurk/core';
import type { ActiveRun, ScheduleList, ServerInfo, Settings, SiteView, StoredPreset } from '@disco-lurk/server/contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from './api';
import { App } from './app';
import { copy } from './copy';
import { RunPage } from './pages/run';
import { SchedulesPage } from './pages/schedules';
import type { Platform } from './platform';
import { Store, StoreContext, type State } from './store';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const categories: Category[] = [{ name: '开发调优', path: '/c/develop/4', id: 4, enabledByDefault: true }];
const siteView: SiteView = {
  site: {
    id: 'linuxdo',
    displayName: 'LINUX DO',
    baseUrl: 'https://linux.invalid',
    kind: 'discourse',
    login: 'headed',
    categorySource: 'builtin',
    builtinCategories: categories,
    progressSource: 'none',
    behaviorVerified: { clickEntryRequired: true },
  },
  categories,
};

const preset: StoredPreset = {
  id: 'linuxdo-default',
  name: 'LINUX DO 默认',
  siteId: 'linuxdo',
  profileId: 'linuxdo/main',
  browserMode: 'headed',
  browseMode: 'deep',
  runMode: { kind: 'endless' },
  categoryPaths: ['/c/develop/4'],
  interaction: { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5, riskAcknowledged: false } },
  extraWait: { enabled: true, minSec: 1, maxSec: 3 },
  samplePerCategory: { min: 3, max: 8 },
};

const settings: Settings = { notifications: true, closeToTray: true, updateCheck: false, currentPresetId: 'linuxdo-default', language: 'zh-CN' };

function activeRun(over: Partial<ActiveRun> = {}): ActiveRun {
  const plan: RunPlanSnapshot = {
    id: 'run-1',
    siteId: 'linuxdo',
    profileId: 'linuxdo/main',
    browserMode: 'headed',
    seed: 1,
    plannedAt: new Date().toISOString(),
    materializedAt: new Date().toISOString(),
    preset: { presetId: preset.id, browseMode: 'deep', runMode: { kind: 'endless' }, categories, interaction: preset.interaction, extraWait: preset.extraWait, samplePerCategory: preset.samplePerCategory, experiments: EXPERIMENTS_OFF },
  };
  return { runId: 'run-1', presetId: preset.id, presetName: preset.name, plan, startedAt: new Date().toISOString(), state: 'queued', stopping: false, ...over };
}

function fakeApi() {
  const api = {
    savePreset: vi.fn(async (p: StoredPreset) => p),
    presets: vi.fn(async () => [preset]),
    startRun: vi.fn(async () => activeRun()),
    stopRun: vi.fn(async () => activeRun({ state: 'stopping', stopping: true })),
    defaultPreset: vi.fn(async () => preset),
    profiles: vi.fn(async () => []),
    history: vi.fn(async () => []),
    patchProfile: vi.fn(),
  };
  return api;
}

function mount(api: ReturnType<typeof fakeApi>, page: () => ReturnType<typeof h> = () => h(RunPage, {})) {
  const state: State = {
    info: { version: '0.1.0', headlessOnly: false, platform: 'darwin' } satisfies ServerInfo,
    stream: 'open',
    sites: [siteView],
    profiles: [{ id: 'linuxdo/main', siteId: 'linuxdo', name: 'main', channel: 'chrome', status: 'ready', busy: false }],
    presets: [preset],
    settings,
    runs: {},
    events: {},
    logins: {},
    history: [],
    update: null,
  };
  const store = new Store(api as unknown as Api, state);
  render(h(StoreContext.Provider, { value: store }, page()));
  return store;
}

const replySwitch = () => screen.getByRole('switch', { name: copy.run.reply }) as HTMLInputElement;

describe('run page', () => {
  it('saves the preset and starts it, then stops the run and shows the safe-stop state', async () => {
    const api = fakeApi();
    const store = mount(api);
    fireEvent.click(screen.getByRole('button', { name: copy.run.start }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith('linuxdo-default'));
    expect(api.savePreset).toHaveBeenCalledWith(expect.objectContaining({ id: 'linuxdo-default', profileId: 'linuxdo/main' }));

    store.apply({ type: 'event', runId: 'run-1', event: { type: 'state', at: new Date().toISOString(), state: 'browsing' } });
    const stop = await screen.findByRole('button', { name: copy.run.stop });
    fireEvent.click(stop);
    await waitFor(() => expect(api.stopRun).toHaveBeenCalledWith('run-1'));
    await screen.findByRole('button', { name: copy.run.stopping });

    store.apply({
      type: 'run',
      run: activeRun({
        state: 'completed',
        result: {
          outcome: 'completed',
          stopCause: 'user',
          baseline: 'not-applicable',
          levels: { initial: null, final: null },
          stats: { ...emptyStats(), attempted: { topics: 2, floors: 9, likes: 0, replyLikes: 0, replies: 0 }, confirmed: { topics: 2, floors: 8, likes: 0, replyLikes: 0, replies: 0, repliedTopics: 0 }, elapsedMs: 61_000 },
        },
      }),
    });
    await screen.findByRole('button', { name: copy.run.start });
    expect(screen.getByText(copy.stopCauses.user!)).toBeTruthy();
  });

  it('keeps automatic replies off when the risk dialog is cancelled', async () => {
    const api = fakeApi();
    mount(api);
    fireEvent.click(replySwitch());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: copy.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(replySwitch().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: copy.run.start }));
    await waitFor(() => expect(api.savePreset).toHaveBeenCalled());
    const [saved] = api.savePreset.mock.calls[0]!;
    expect(saved.interaction.reply).toMatchObject({ enabled: false, riskAcknowledged: false });
  });

  it('turns automatic replies on only after the risk is confirmed, and saves the acknowledgement with them', async () => {
    const api = fakeApi();
    mount(api);
    fireEvent.click(replySwitch());
    fireEvent.click(await screen.findByRole('button', { name: copy.replyRisk.confirm }));
    await waitFor(() => expect(replySwitch().checked).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: copy.run.start }));
    await waitFor(() => expect(api.savePreset).toHaveBeenCalled());
    const [saved] = api.savePreset.mock.calls[0]!;
    expect(saved.interaction.reply).toMatchObject({ enabled: true, riskAcknowledged: true });
  });

  it('withdraws the acknowledgement when replies are turned off again', async () => {
    const api = fakeApi();
    mount(api);
    fireEvent.click(replySwitch());
    fireEvent.click(await screen.findByRole('button', { name: copy.replyRisk.confirm }));
    await waitFor(() => expect(replySwitch().checked).toBe(true));
    fireEvent.click(replySwitch());
    await waitFor(() => expect(replySwitch().checked).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: copy.run.start }));
    await waitFor(() => expect(api.savePreset).toHaveBeenCalled());
    expect(api.savePreset.mock.calls[0]![0].interaction.reply).toMatchObject({ enabled: false, riskAcknowledged: false });
  });
});

describe('site progress while running', () => {
  const at = new Date().toISOString();
  const viewed = (n: number): LevelSnapshot => ({ source: 'connect-linuxdo', metrics: [{ label: '浏览话题', key: 'topicsViewed', current: n, required: 500 }] });
  const cells = () => [...document.querySelectorAll('table.levels tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

  it('shows the initial read at once and replaces the final read when it comes again', async () => {
    const store = mount(fakeApi());
    store.set({ runs: { 'run-1': activeRun({ state: 'browsing' }) } });
    store.apply({ type: 'event', runId: 'run-1', event: { type: 'levels', at, kind: 'initial', snapshot: viewed(100) } });
    await waitFor(() => expect(cells()).toEqual([['100', '100', '—', '500', '—']]));
    store.apply({ type: 'event', runId: 'run-1', event: { type: 'levels', at, kind: 'final', snapshot: viewed(101) } });
    await waitFor(() => expect(cells()[0]![2]).toBe('101'));
    store.apply({ type: 'event', runId: 'run-1', event: { type: 'levels', at, kind: 'final', snapshot: viewed(103) } });
    await waitFor(() => expect(cells()).toEqual([['100', '100', '103', '500', '+3']]));
  });

  it('says the site may lag when it reports fewer new topics than were confirmed', async () => {
    const store = mount(fakeApi());
    const stats: RunStats = { ...emptyStats(), confirmed: { ...emptyStats().confirmed, topics: 3 }, reported: { topicsViewed: { initial: 100, final: 101 } } };
    store.set({
      runs: {
        'run-1': activeRun({ state: 'completed', result: { outcome: 'completed', stopCause: 'target', baseline: 'present', levels: { initial: viewed(100), final: viewed(101) }, stats } }),
      },
    });
    await screen.findByText(copy.levels.lag(2));
  });
});

describe('schedules page', () => {
  const view = (paused: boolean): ScheduleList => ({
    available: true,
    schedules: [
      {
        spec: {
          id: 's1',
          name: '每天',
          profileId: 'linuxdo/main',
          presetId: preset.id,
          enabled: true,
          browserMode: 'headless',
          timezone: 'UTC',
          trigger: { kind: 'cron', expression: '0 8 * * *' },
          misfire: { policy: 'skip', graceMinutes: 30 },
          overlap: 'skip',
          unavailableDisplay: 'skip',
          runOnStart: false,
        },
        paused,
        next: null,
      },
    ],
  });

  it('resumes a paused schedule and shows its run history', async () => {
    const api = {
      ...fakeApi(),
      schedules: vi.fn(async () => view(true)),
      resumeSchedule: vi.fn(async () => view(false)),
      pauseSchedule: vi.fn(async () => view(true)),
      scheduleHistory: vi.fn(async () => [
        { at, snapshotId: 'p1', cause: 'planned', outcome: 'started', runId: 'r1', ended: { at, outcome: 'completed', stopCause: 'target' } },
        { at, snapshotId: 'p2', cause: 'planned', outcome: 'skipped', reason: 'paused' },
      ]),
    };
    mount(api as never, () => h(SchedulesPage, {}));
    fireEvent.click(await screen.findByRole('button', { name: copy.schedules.resume }));
    await waitFor(() => expect(api.resumeSchedule).toHaveBeenCalledWith('s1'));
    await screen.findByRole('button', { name: copy.schedules.pause });
    fireEvent.click(screen.getByRole('button', { name: copy.schedules.history }));
    await screen.findByText(/计划 已跳过（已暂停）/);
    expect(screen.getByText(/计划 已开始 → /).textContent).toContain(copy.stopCauses.target!);
  });

  it('is read-only while another process owns the schedules', async () => {
    const api = { ...fakeApi(), schedules: vi.fn(async (): Promise<ScheduleList> => ({ available: false, reason: 'owned by process 42', schedules: [] })) };
    mount(api as never, () => h(SchedulesPage, {}));
    await screen.findByText(copy.schedules.notOwned('owned by process 42'));
    expect(screen.queryByRole('button', { name: copy.schedules.create })).toBeNull();
  });
});

const at = new Date().toISOString();

describe('remote access', () => {
  const remote = (stored: string | null): Platform => ({
    desktop: false,
    connect: () => Promise.reject(new Error('no shell')),
    onRestarted: () => {},
    autostart: null,
    installUpdate: () => Promise.reject(new Error('no shell')),
    storedToken: () => stored,
    storeToken: vi.fn(),
  });

  it('asks for a token when none is stored and refuses an empty one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(h(App, { platform: remote(null), origin: 'http://nas.invalid:8080' }));
    await screen.findByText(copy.token.title);
    fireEvent.click(screen.getByRole('button', { name: copy.token.submit }));
    await screen.findByText(copy.token.missing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the token as invalid when the server answers 401, sending it only as a bearer header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const platform = remote(null);
    render(h(App, { platform, origin: 'http://nas.invalid:8080' }));
    const input = (await screen.findByLabelText(copy.token.label)) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'wrong-token' } });
    fireEvent.click(screen.getByRole('button', { name: copy.token.submit }));
    await screen.findByText(copy.token.invalid);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls) {
      expect(url).not.toContain('wrong-token');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wrong-token');
    }
    expect(platform.storeToken).toHaveBeenLastCalledWith(null);
  });
});
