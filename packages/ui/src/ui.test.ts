// @vitest-environment happy-dom
import { emptyStats, EXPERIMENTS_OFF, type Category, type LevelSnapshot, type RunPlanSnapshot, type RunStats } from '@disco-lurk/core';
import type { ActiveRun, LoggedEvent, RunRecord, ScheduleList, ServerInfo, Settings, SiteView, StoredPreset } from '@disco-lurk/server/contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { h } from 'preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Api } from './api';
import { App } from './app';
import { LogPanel } from './components/log';
import { copy } from './copy';
import { RunPage } from './pages/run';
import { SchedulesPage } from './pages/schedules';
import { DashboardPage } from './pages/dashboard';
import { HistoryPage } from './pages/history';
import { SettingsPage } from './pages/settings';
import type { Platform } from './platform';
import { FINISHED_EVENTS_TTL_MS, Store, StoreContext, type State } from './store';

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

const settings: Settings = {
  notifications: true,
  notifyOnStart: true,
  updateCheck: false,
  currentPresetId: 'linuxdo-default',
  language: 'zh-CN',
  historyLimit: 200,
  ledgerDays: 30,
  reading: { samplePerCategory: { min: 3, max: 8 }, extraWait: { enabled: true, minSec: 1, maxSec: 3 } },
};

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

function mount(api: ReturnType<typeof fakeApi>, page: () => ReturnType<typeof h<any>> = () => h(RunPage, {}), patch: Partial<State> = {}) {
  const state: State = {
    info: { version: '0.1.0', headlessOnly: false, platform: 'darwin' } satisfies ServerInfo,
    stream: 'open',
    sites: [siteView],
    profiles: [{ id: 'linuxdo/main', siteId: 'linuxdo', name: 'main', channel: 'chrome', status: 'ready', busy: false }],
    presets: [preset],
    settings,
    runs: {},
    events: {},
    live: {},
    logins: {},
    history: [],
    schedules: { available: true, schedules: [] },
    update: null,
    ...patch,
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

    store.apply({ type: 'event', runId: 'run-1', event: { seq: 1, type: 'state', at: new Date().toISOString(), state: 'browsing' } });
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

  it('starts another site while one runs, and shows the running one again on switching back', async () => {
    const otherSite: SiteView = { site: { ...siteView.site, id: 'docofcard', displayName: '卡粉论坛', baseUrl: 'https://card.invalid' }, categories };
    const otherPreset: StoredPreset = { ...preset, id: 'docofcard-default', name: '卡粉默认', siteId: 'docofcard', profileId: 'docofcard/main' };
    const lighter: StoredPreset = { ...preset, id: 'linuxdo-light', name: 'LINUX DO 轻量' };
    const api = fakeApi();
    api.presets.mockResolvedValue([lighter, preset, otherPreset]);
    api.startRun.mockResolvedValue(activeRun({ runId: 'run-2', presetId: otherPreset.id, plan: { ...activeRun().plan, id: 'run-2', siteId: 'docofcard', profileId: 'docofcard/main' } }));
    const store = mount(api, undefined, {
      sites: [siteView, otherSite],
      profiles: [
        { id: 'linuxdo/main', siteId: 'linuxdo', name: 'main', channel: 'chrome', status: 'ready', busy: true },
        { id: 'docofcard/main', siteId: 'docofcard', name: 'main', channel: 'chrome', status: 'ready', busy: false },
      ],
      presets: [lighter, preset, otherPreset],
      runs: { 'run-1': activeRun({ state: 'browsing' }) },
    });
    const siteSelect = () => screen.getByRole('combobox', { name: copy.run.site }) as HTMLSelectElement;
    await screen.findByRole('button', { name: copy.run.stop });
    expect(siteSelect().closest('fieldset')!.disabled).toBe(false);

    fireEvent.change(siteSelect(), { target: { value: 'docofcard' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.run.start }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith('docofcard-default'));
    store.set({ settings: { ...settings, currentPresetId: 'docofcard-default' } });

    fireEvent.change(siteSelect(), { target: { value: 'linuxdo' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: copy.run.preset }) as HTMLSelectElement).value).toBe('linuxdo-default'));
    expect(screen.getAllByRole('button', { name: copy.run.stop })).toHaveLength(1);
  });
});

describe('site progress while running', () => {
  const at = new Date().toISOString();
  const viewed = (n: number): LevelSnapshot => ({ source: 'connect-linuxdo', metrics: [{ label: '浏览话题', key: 'topicsViewed', current: n, required: 500 }] });
  const cells = () => [...document.querySelectorAll('table.levels tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

  it('shows the initial read at once and replaces the final read when it comes again', async () => {
    const store = mount(fakeApi());
    store.set({ runs: { 'run-1': activeRun({ state: 'browsing' }) } });
    store.apply({ type: 'event', runId: 'run-1', event: { seq: 1, type: 'levels', at, kind: 'initial', snapshot: viewed(100) } });
    await waitFor(() => expect(cells()).toEqual([['100', '100', '—', '500', '—']]));
    store.apply({ type: 'event', runId: 'run-1', event: { seq: 2, type: 'levels', at, kind: 'final', snapshot: viewed(101) } });
    await waitFor(() => expect(cells()[0]![2]).toBe('101'));
    store.apply({ type: 'event', runId: 'run-1', event: { seq: 3, type: 'levels', at, kind: 'final', snapshot: viewed(103) } });
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
    const store = mount(api as never, () => h(SchedulesPage, {}), { schedules: view(true) });
    fireEvent.click(await screen.findByRole('button', { name: copy.schedules.resume }));
    await waitFor(() => expect(api.resumeSchedule).toHaveBeenCalledWith('s1'));
    await screen.findByRole('button', { name: copy.schedules.pause });
    fireEvent.click(screen.getByRole('button', { name: copy.schedules.history }));
    await screen.findByText(/计划 已跳过（已暂停）/);
    expect(screen.getByText(/计划 已开始 → /).textContent).toContain(copy.stopCauses.target!);
    // A change made elsewhere (the tray, another tab, the loop) arrives as a `schedules` frame.
    store.apply({ type: 'schedules', list: view(true) });
    await screen.findByRole('button', { name: copy.schedules.resume });
  });

  it('is read-only while another process owns the schedules', async () => {
    mount(fakeApi(), () => h(SchedulesPage, {}), { schedules: { available: false, reason: 'owned by process 42', schedules: [] } });
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

describe('store events', () => {
  const at = new Date().toISOString();
  const warning = (seq: number) => ({ seq, type: 'warning' as const, at, code: `w${seq}`, message: '' });

  it('merges stored and live events by seq, dropping frames already in the stored log', async () => {
    const api = { ...fakeApi(), runEvents: vi.fn(async () => [warning(1), warning(2)]) };
    const store = mount(api);
    store.apply({ type: 'event', runId: 'run-1', event: warning(2) });
    store.apply({ type: 'event', runId: 'run-1', event: warning(3) });
    await store.backfill('run-1');
    expect(store.state.events['run-1']!.map((e) => e.seq)).toEqual([1, 2, 3]);
    store.apply({ type: 'event', runId: 'run-1', event: warning(3) });
    store.apply({ type: 'event', runId: 'run-1', event: warning(4) });
    expect(store.state.events['run-1']!.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('forgets a finished run\'s events ten minutes after it ended', () => {
    vi.useFakeTimers();
    try {
      const store = mount(fakeApi());
      store.apply({ type: 'event', runId: 'run-1', event: warning(1) });
      const result = { outcome: 'completed', stopCause: 'target', baseline: 'not-applicable', levels: { initial: null, final: null }, stats: emptyStats() } as const;
      const run = activeRun({ state: 'completed', result });
      store.apply({ type: 'run', run, record: { runId: run.runId, presetId: run.presetId, presetName: run.presetName, plan: run.plan, startedAt: run.startedAt, endedAt: run.startedAt, result } });
      // The ended run's record goes straight into history.
      expect(store.state.history.map((r) => r.runId)).toEqual(['run-1']);
      vi.advanceTimersByTime(FINISHED_EVENTS_TTL_MS - 1);
      expect(store.state.events['run-1']).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.state.events['run-1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('spec pages', () => {
  const ended = (): RunRecord => {
    const run = activeRun();
    return {
      runId: 'run-0',
      presetId: run.presetId,
      presetName: run.presetName,
      plan: run.plan,
      startedAt: at,
      endedAt: at,
      result: {
        outcome: 'completed',
        stopCause: 'target',
        baseline: 'present',
        levels: { initial: { source: 'connect-linuxdo', metrics: [{ label: '浏览话题', key: 'topicsViewed', current: 10, required: 500 }] }, final: { source: 'connect-linuxdo', metrics: [{ label: '浏览话题', key: 'topicsViewed', current: 14, required: 500 }] } },
        stats: { ...emptyStats(), confirmed: { ...emptyStats().confirmed, topics: 4 } },
      },
    };
  };

  it('shows the last run\'s site progress against each requirement and its numbers on the dashboard', async () => {
    const rec = ended();
    rec.result.levels.final!.metrics.push({ label: '被禁言', key: 'silenced', current: 0, required: 0, limit: true });
    mount(fakeApi(), () => h(DashboardPage, { go: () => {} }), { history: [rec] });
    await screen.findByText(copy.dashboard.goals);
    const meter = screen.getByRole('meter', { name: '浏览话题' });
    expect(meter.getAttribute('aria-valuenow')).toBe('14');
    expect(meter.closest('.meter')?.textContent).toContain(copy.dashboard.left(486));
    expect(meter.closest('.meter')?.textContent).toContain('+4');
    // A ceiling that holds counts as met and is listed apart from the goals.
    expect(document.querySelector('ul.limits .limit.met')?.textContent).toContain('被禁言');
    expect(screen.getByText(copy.dashboard.met(0, 1))).toBeTruthy();
    expect(document.querySelector('.tiles')?.textContent).toContain('4');
  });

  it('offers each history entry\'s log for download', async () => {
    const api = { ...fakeApi(), history: vi.fn(async () => [ended()]), runLog: vi.fn(async () => '{"seq":1}\n'), raw: vi.fn(async () => new Response('{"path":"/x"}')) };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    mount(api as never, () => h(HistoryPage, {}), { history: [ended()] });
    fireEvent.click(await screen.findByRole('button', { name: copy.history.download }));
    // A browser downloads the log; the desktop shell writes it through the sidecar.
    await waitFor(() => expect(api.runLog.mock.calls.length + api.raw.mock.calls.length).toBe(1));
  });

  it('lists the built-in sites on the settings page without a way to add one', async () => {
    const api = { ...fakeApi(), doctor: vi.fn(async () => ({ version: 'x', platform: 'p', arch: 'a', generatedAt: at, checks: [] })) };
    mount(api as never, () => h(SettingsPage, { onTokenRotated: () => {} }));
    await screen.findByText(copy.settings.sitesHint);
    expect(screen.getByText(siteView.site.displayName)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '地址' })).toBeNull();
    expect(screen.queryByText(/关闭窗口时隐藏到托盘/)).toBeNull();
  });
});

describe('log panel', () => {
  const topic = (seq: number): LoggedEvent => ({ seq, type: 'topic', at: new Date().toISOString(), topicId: String(seq), phase: 'read' });
  const events = (n: number) => Array.from({ length: n }, (_, i) => topic(i + 1));

  it('scrolls only its own box: follows new lines, pauses while scrolled up, resumes at the bottom', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const api = {} as Api;
    const view = render(h(LogPanel, { api, runId: 'run-1', events: events(10) }));
    const box = screen.getByRole('log');
    // happy-dom does no layout: each line is 20px tall in a 100px box.
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => box.querySelectorAll('.line').length * 20 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 100 });
    const bodyTop = document.body.scrollTop;

    view.rerender(h(LogPanel, { api, runId: 'run-1', events: events(300) }));
    await waitFor(() => expect(box.scrollTop).toBe(6000));

    box.scrollTop = 40;
    fireEvent.scroll(box);
    view.rerender(h(LogPanel, { api, runId: 'run-1', events: events(320) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.scrollTop).toBe(40);

    box.scrollTop = 6400 - 100;
    fireEvent.scroll(box);
    view.rerender(h(LogPanel, { api, runId: 'run-1', events: events(340) }));
    await waitFor(() => expect(box.scrollTop).toBe(6800));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body.scrollTop).toBe(bodyTop);
  });

  it('keeps the document fixed to the window and every scroll inside its own region', () => {
    const css = readFileSync(`${import.meta.dirname}/styles.css`, 'utf8');
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('html,\nbody')).toMatch(/overflow: hidden/);
    expect(rule('.log')).toMatch(/overflow-y: auto/);
    expect(rule('.log')).toMatch(/max-height:/);
    expect(rule('.content')).toMatch(/overflow-y: auto/);
    expect(rule('.content')).toMatch(/min-height: 0/);
    // Hidden inputs are absolutely positioned; a positioned label holds each one inside the scrolling content.
    for (const label of ['.toggle', '.segmented label', '.chip']) expect(rule(label)).toMatch(/position: relative/);
  });
});
