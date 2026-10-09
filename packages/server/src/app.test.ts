import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscoLurkCoordinator,
  LOGIN_WAIT_MS,
  seededRandom,
  systemClock,
  systemSleeper,
  type AuthMode,
  type AuthResult,
  type Category,
  type CategoryStore,
  type InterruptibleSleeper,
  type LevelSnapshot,
  type RunEvent,
  type Site,
} from '@disco-lurk/core';
import { FixtureForum, fixtureSite } from '@disco-lurk/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, defaultPreset, isNewer, type LurkApp, type ShellChannel } from './app';
import type { ActiveRun, LoginView, RunRecord, ScheduleHistoryEntry, ScheduleList, ServerFrame, Settings, StoredPreset } from './contract';
import { startServer, type LurkServer } from './server';
import { DEFAULT_SETTINGS, RunHistory } from './store';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Every kernel wait shrinks to a few milliseconds, so a fixture run takes real but short time. */
const fastSleeper: InterruptibleSleeper = { sleep: (ms, signal) => systemSleeper.sleep(Math.min(ms, 3), signal) };

const categories: Category[] = [
  { name: 'a', path: '/c/a/1', id: 1, enabledByDefault: true },
  { name: 'b', path: '/c/b/2', id: 2, enabledByDefault: false },
];
const site = fixtureSite({ id: 'fx', displayName: 'Fixture', categorySource: 'builtin', builtinCategories: categories });

class MemoryCategories implements CategoryStore {
  async load() {
    return [];
  }
  async save() {}
}

interface Harness {
  base: string;
  token: string;
  app: LurkApp;
  server: LurkServer;
  shell: { notices: Array<[string, string]>; settings: Settings[]; tokens: string[]; active: number[] };
  locks: Map<string, number>;
  /** How the next sign-in check answers, per mode. */
  auth: { next: (mode: AuthMode, signal?: AbortSignal) => Promise<AuthResult> };
  dataDir: string;
  shutdowns: () => number;
  /** The browser form of every session the kernel opened, in order. */
  opens: string[];
}

let current: Harness | undefined;
afterEach(async () => {
  if (!current) return;
  await current.app.close();
  await current.server.close();
  current = undefined;
});

interface BootOptions {
  headlessOnly?: boolean;
  /** Reuses a data directory, as a restarted sidecar does. */
  dataDir?: string;
  /** Answers the progress page; the fixture site then reports one. */
  progress?: (kind: 'initial' | 'final') => LevelSnapshot | null;
  extraSites?: Site[];
}

async function boot(opts: BootOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'lurk-app-'));
  const runSite = opts.progress ? { ...site, progressSource: 'trust-level-docofcard' as const } : site;
  const profilesDir = join(dataDir, 'profiles');
  const locks = new Map<string, number>();
  const shell: Harness['shell'] = { notices: [], settings: [], tokens: [], active: [] };
  const channel: ShellChannel = {
    notify: (t, b) => shell.notices.push([t, b]),
    settings: (s) => shell.settings.push(s),
    token: (t) => shell.tokens.push(t),
    activeRuns: (n) => shell.active.push(n),
  };
  const auth: Harness['auth'] = { next: async () => ({ status: 'authenticated', username: 'alice' }) };
  let app: LurkApp;
  const opens: string[] = [];
  const coordinator = new DiscoLurkCoordinator({
    deps: { clock: systemClock, random: seededRandom(1), sleeper: fastSleeper },
    categories: new MemoryCategories(),
    resolveProfile: async (id) => ({ profile: await app.services.profiles.resolve(id), site: runSite }),
    open: async (req) => {
      opens.push(req.browserMode);
      const progress = opts.progress;
      const forum = new FixtureForum({
        site: runSite,
        ...(progress ? { progress: async (kind: 'initial' | 'final') => progress(kind) } : {}),
        sleeper: fastSleeper,
        topics: (path, call) => Array.from({ length: 3 }, (_, i) => ({ id: `${path}-${call}-${i}`, title: 't', unread: true, pinned: false })),
        latency: { collect: 2, enter: 2, dwell: 2, back: 2 },
        auth: (mode, signal) => auth.next(mode, signal),
      });
      return { forum, closed: new AbortController().signal, close: async () => {} };
    },
  });
  let shutdowns = 0;
  app = createApp({
    version: '1.2.3',
    clock: systemClock,
    dataDir,
    profilesDir,
    coordinator,
    sites: [runSite, ...(opts.extraSites ?? [])],
    categories: new MemoryCategories(),
    sleeper: fastSleeper,
    lockHolder: async (dir) => locks.get(dir) ?? null,
    doctor: async () => ({ checks: [] }),
    shutdown: async () => void shutdowns++,
    displayAvailable: () => true,
    shell: channel,
    latestRelease: async () => ({ tag: 'v1.3.0', url: 'https://example.invalid/r' }),
    releasePage: 'https://example.invalid/releases',
    ...(opts.headlessOnly ? { headlessOnly: true } : {}),
  });
  await app.start();
  const token = randomBytes(32).toString('base64url');
  const server = await startServer({ host: '127.0.0.1', port: 0, token, version: '1.2.3', clock: systemClock, routes: app.routes, hub: app.hub, loopbackFailureDelayMs: 1 });
  app.bindTokenRotation((t) => server.rotateToken(t));
  current = { base: `http://127.0.0.1:${server.port}`, token, app, server, shell, locks, auth, dataDir, shutdowns: () => shutdowns, opens };
  return current;
}

function api(h: Harness) {
  const call = async <T = unknown>(method: string, path: string, body?: unknown, token = h.token) => {
    const res = await fetch(`${h.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text && res.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text) as T, headers: res.headers };
  };
  return call;
}

async function events(h: Harness) {
  const ws = new WebSocket(h.base.replace('http', 'ws') + '/events');
  const frames: ServerFrame[] = [];
  const waiters: Array<{ test: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as ServerFrame;
    frames.push(f);
    for (const w of waiters.slice()) if (w.test(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(f);
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'auth', token: h.token }));
  const until = (test: (f: ServerFrame) => boolean, ms = 5000) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const hit = frames.find(test);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('frame not seen in time')), ms);
      waiters.push({ test, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  await until((f) => f.type === 'auth-ok');
  return { ws, frames, until };
}

const preset = (over: Partial<StoredPreset> = {}): StoredPreset => ({
  ...defaultPreset(site, categories, DEFAULT_SETTINGS.reading),
  id: 'p1',
  name: '测试',
  profileId: 'fx/main',
  browserMode: 'headless',
  runMode: { kind: 'endless' },
  extraWait: { enabled: false, minSec: 1, maxSec: 3 },
  ...over,
});

async function withProfile(h: Harness, name = 'main') {
  const res = await api(h)('POST', '/profiles', { siteId: 'fx', name, channel: 'chrome' });
  expect(res.status).toBe(201);
}

describe('server API', () => {
  it('lists sites with their categories and a default preset that keeps likes and replies off', async () => {
    const h = await boot();
    const call = api(h);
    const sites = await call<Array<{ site: { id: string }; categories: Category[] }>>('GET', '/sites');
    expect(sites.body.map((s) => s.site.id)).toEqual(['fx']);
    expect(sites.body[0]!.categories).toHaveLength(2);
    const d = await call<StoredPreset>('GET', '/sites/fx/default-preset');
    expect(d.body).toMatchObject({ browseMode: 'deep', runMode: { kind: 'topics', min: 15, max: 40 }, categoryPaths: ['/c/a/1'] });
    expect(d.body.interaction.like.enabled).toBe(false);
    expect(d.body.interaction.reply.enabled).toBe(false);
    expect((await call('GET', '/sites/nope/default-preset')).status).toBe(404);
  });

  it('persists presets and turns automatic replies on only with their risk acknowledged', async () => {
    const h = await boot();
    const call = api(h);
    expect((await call('PUT', '/presets/p1', { preset: preset() })).status).toBe(200);
    const replying = (riskAcknowledged: boolean) => preset({ interaction: { ...preset().interaction, reply: { enabled: true, rate: 5, riskAcknowledged } } });
    const refused = await call<{ error: string }>('PUT', '/presets/p1', { preset: replying(false) });
    expect(refused.status).toBe(428);
    expect(refused.body.error).toBe('reply-confirmation-required');
    expect((await call<StoredPreset[]>('GET', '/presets')).body[0]!.interaction.reply.enabled).toBe(false);
    expect((await call('PUT', '/presets/p1', { preset: replying(false), confirmReply: true })).status).toBe(422);
    expect((await call('PUT', '/presets/p1', { preset: replying(true) })).status).toBe(200);
    expect((await call('PUT', '/presets/p1', { preset: { ...preset(), interaction: { ...preset().interaction, like: { ...preset().interaction.like, maxReplies: 5 } } } })).status).toBe(422);
    expect((await call('PUT', '/presets/p1', { preset: { ...preset(), runMode: { kind: 'topics', min: 5, max: 2 } } })).status).toBe(422);
    expect((await call('PUT', '/presets/other', { preset: preset() })).status).toBe(422);

    // A restart reads the same file back.
    const again = createApp({ ...appDepsOf(h) });
    await again.start();
    expect(again.services.presets.get('p1')?.interaction.reply.enabled).toBe(true);
    expect((await call('DELETE', '/presets/p1')).status).toBe(204);
    expect((await call('DELETE', '/presets/p1')).status).toBe(404);
  });

  it('starts a run, streams its RunEvents, refuses a second run on the same Profile and stops it', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    const ws = await events(h);
    const started = await call<ActiveRun>('POST', '/runs', { presetId: 'p1' });
    expect(started.status).toBe(202);
    const runId = started.body.runId;
    await ws.until((f) => f.type === 'event' && f.runId === runId && f.event.type === 'state' && f.event.state === 'browsing');
    await ws.until((f) => f.type === 'event' && f.event.type === 'topic' && f.event.phase === 'read');

    const second = await call<{ error: string }>('POST', '/runs', { presetId: 'p1' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('profile-busy');
    const profiles = await call<Array<{ id: string; status: string; busy: boolean }>>('GET', '/profiles');
    expect(profiles.body).toEqual([expect.objectContaining({ id: 'fx/main', status: 'locked', busy: true })]);
    expect((await call<ActiveRun[]>('GET', '/runs/active')).body.map((r) => r.runId)).toEqual([runId]);

    expect((await call('POST', `/runs/${runId}/stop`)).status).toBe(200);
    const ended = (await ws.until((f) => f.type === 'run' && f.run.runId === runId && f.run.result !== undefined)) as Extract<ServerFrame, { type: 'run' }>;
    expect(ended.run.result).toMatchObject({ outcome: 'completed', stopCause: 'user' });
    expect((await call<ActiveRun[]>('GET', '/runs/active')).body).toEqual([]);

    const history = await call<RunRecord[]>('GET', '/runs/history');
    expect(history.body.map((r) => r.runId)).toEqual([runId]);
    expect(history.body[0]!.result.stats.confirmed.topics).toBeGreaterThan(0);
    const log = await call<string>('GET', `/runs/${runId}/log?types=state`);
    expect(log.headers.get('content-disposition')).toContain(`${runId}.jsonl`);
    const states = log.body.trim().split('\n').map((l) => (JSON.parse(l) as RunEvent).type);
    expect(new Set(states)).toEqual(new Set(['state']));
    const exported = await call<{ path: string; lines: number }>('POST', `/runs/${runId}/export`, { types: ['state'] });
    expect(exported.body.path.startsWith(join(h.dataDir, 'exports'))).toBe(true);
    expect(exported.body.lines).toBe(states.length);
    const all = await call<RunEvent[]>('GET', `/runs/${runId}/events`);
    expect(all.body.some((e) => e.type === 'topic')).toBe(true);
    expect(h.shell.notices.map(([t]) => t)).toContain('运行结束');
    expect(h.shell.active).toEqual([1, 0]);
    expect((await call<Settings>('GET', '/settings')).body.currentPresetId).toBe('p1');

    // The Profile is free again at once.
    const next = await call<ActiveRun>('POST', '/runs/current');
    expect(next.status).toBe(202);
    await call('POST', '/runs/stop');
    await ws.until((f) => f.type === 'run' && f.run.runId === next.body.runId && f.run.result !== undefined);
    ws.ws.close();
  });

  it('leaves replies off for a stored preset whose risk was never acknowledged', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    // Written past the endpoint, as a hand-edited presets.json would be.
    await h.app.services.presets.put(preset({ interaction: { ...preset().interaction, reply: { enabled: true, rate: 100, riskAcknowledged: false } } }));
    const run = await call<ActiveRun>('POST', '/runs', { presetId: 'p1' });
    expect(run.status).toBe(202);
    expect(run.body.plan.preset.interaction.reply).toMatchObject({ enabled: false, riskAcknowledged: false });
    await call('POST', '/runs/stop');
  });

  it('forwards levels events and keeps them in the run log', async () => {
    const snapshot = (n: number): LevelSnapshot => ({ source: 'trust-level-docofcard', metrics: [{ label: '已读帖子', key: 'postsRead', current: n, required: 500 }] });
    let reads = 0;
    const h = await boot({ progress: () => snapshot(100 + 10 * reads++) });
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset({ runMode: { kind: 'topics', min: 1, max: 1 }, browseMode: 'quick' }) });
    const ws = await events(h);
    const run = await call<ActiveRun>('POST', '/runs', { presetId: 'p1' });
    await ws.until((f) => f.type === 'run' && f.run.runId === run.body.runId && f.run.result !== undefined);
    const kinds = ws.frames.flatMap((f) => (f.type === 'event' && f.event.type === 'levels' ? [f.event.kind] : []));
    expect(kinds).toEqual(['initial', 'final']);
    const log = await call<string>('GET', `/runs/${run.body.runId}/log?types=levels`);
    expect(log.body.trim().split('\n').map((l) => (JSON.parse(l) as RunEvent).type)).toEqual(['levels', 'levels']);
    ws.ws.close();
  });

  it('records a run that was in progress when the previous sidecar died as failed', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    const ws = await events(h);
    const started = await call<ActiveRun>('POST', '/runs', { presetId: 'p1' });
    await ws.until((f) => f.type === 'event' && f.event.type === 'stats');
    ws.ws.close();
    // A second app over the same directory stands in for the restarted sidecar.
    const alive = createApp(appDepsOf(h));
    await alive.start();
    expect((await new RunHistoryProbe(h).list()).some((r) => r.runId === started.body.runId)).toBe(false);
    // The mark now names another process, one that has died.
    const markPath = join(h.dataDir, 'runs', 'open', `${started.body.runId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    writeFileSync(markPath, JSON.stringify({ ...JSON.parse(readFileSync(markPath, 'utf8')), pid: 999_999 }));
    const again = createApp({ ...appDepsOf(h), processAlive: () => false });
    await again.start();
    const rec = (await new RunHistoryProbe(h).list()).find((r) => r.runId === started.body.runId);
    expect(rec?.result).toMatchObject({ outcome: 'failed', failure: { code: 'internal' } });
    expect(rec?.result.stats.confirmed.topics).toBeGreaterThanOrEqual(0);
  });

  it('skips event lines a crash cut short in /events, /log and the export, and counts them', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset({ runMode: { kind: 'topics', min: 1, max: 1 } }) });
    const ws = await events(h);
    const runId = (await call<ActiveRun>('POST', '/runs', { presetId: 'p1' })).body.runId;
    await ws.until((f) => f.type === 'run' && f.run.runId === runId && f.run.result !== undefined);
    ws.ws.close();
    const file = join(h.dataDir, 'runs', `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}.events.jsonl`);
    const whole = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, [whole[0], '{"seq":99,"type":"sta', ...whole.slice(1)].join('\n') + '\n');
    const list = await call<Array<{ seq: number }>>('GET', `/runs/${runId}/events`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(whole.length);
    expect(list.body.map((e) => e.seq)).toEqual(whole.map((_, i) => i + 1));
    expect(list.headers.get('x-skipped-lines')).toBe('1');
    const log = await call<string>('GET', `/runs/${runId}/log?types=state`);
    expect(log.status).toBe(200);
    expect(log.headers.get('x-skipped-lines')).toBe('1');
    expect(log.body.trim().split('\n').every((l) => JSON.parse(l).type === 'state')).toBe(true);
    const exported = await call<{ lines: number; skipped: number }>('POST', `/runs/${runId}/export`, {});
    expect(exported.body).toMatchObject({ lines: whole.length, skipped: 1 });
  });

  it('refuses to move a preset that a schedule runs to another site', async () => {
    const other = fixtureSite({ id: 'fy', displayName: 'Other', categorySource: 'builtin', builtinCategories: categories });
    const h = await boot({ extraSites: [other] });
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    const spec = {
      id: 's1',
      name: 'n',
      profileId: 'fx/main',
      presetId: 'p1',
      enabled: true,
      browserMode: 'headless',
      timezone: 'UTC',
      trigger: { kind: 'cron', expression: '0 8 * * *' },
      misfire: { policy: 'skip', graceMinutes: 30 },
      overlap: 'skip',
      unavailableDisplay: 'skip',
      runOnStart: false,
    };
    await h.app.services.profiles.setHealth({ profileId: 'fx/main', status: 'ready', checkedAt: new Date().toISOString() });
    expect((await call('PUT', '/schedules/s1', spec)).status).toBe(200);
    const moved = await call<{ error: string }>('PUT', '/presets/p1', { preset: preset({ siteId: 'fy', profileId: null }) });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('preset-in-use');
    expect((await call('PUT', '/presets/p1', { preset: preset({ browseMode: 'quick' }) })).status).toBe(200);
    await call('DELETE', '/schedules/s1');
    expect((await call('PUT', '/presets/p1', { preset: preset({ siteId: 'fy', profileId: null }) })).status).toBe(200);
  });

  it('pushes run state as run frames, the ended run with its record, Profiles and schedules as lists', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset({ runMode: { kind: 'topics', min: 1, max: 1 } }) });
    const ws = await events(h);
    const runId = (await call<ActiveRun>('POST', '/runs', { presetId: 'p1' })).body.runId;
    await ws.until((f) => f.type === 'run' && f.run.runId === runId && f.run.state === 'browsing');
    const ended = (await ws.until((f) => f.type === 'run' && f.run.runId === runId && f.record !== undefined)) as Extract<ServerFrame, { type: 'run' }>;
    expect(ended.record).toMatchObject({ runId, result: { outcome: ended.run.result!.outcome } });
    const seqs = ws.frames.flatMap((f) => (f.type === 'event' && f.runId === runId ? [f.event.seq] : []));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    const before = ws.frames.length;
    await call('POST', '/profiles/fx/main/inspect');
    const profileFrames = ws.frames.slice(before).filter((f) => f.type === 'profiles-changed');
    expect(profileFrames).toHaveLength(1);
    expect(profileFrames[0]).toMatchObject({ profiles: [{ id: 'fx/main', health: { status: 'ready' } }] });

    await call('PUT', '/schedules/s1', {
      id: 's1',
      name: 'n',
      profileId: 'fx/main',
      presetId: 'p1',
      enabled: true,
      browserMode: 'headless',
      timezone: 'UTC',
      trigger: { kind: 'cron', expression: '0 8 * * *' },
      misfire: { policy: 'skip', graceMinutes: 30 },
      overlap: 'skip',
      unavailableDisplay: 'skip',
      runOnStart: false,
    });
    await call('POST', '/schedules/s1/pause');
    await ws.until((f) => f.type === 'schedules' && f.list.schedules[0]?.paused === true);
    ws.ws.close();
  });

  it('adds a Discourse site on a public http(s) address, keeps it across restarts and lists it', async () => {
    const h = await boot();
    const call = api(h);
    for (const baseUrl of ['ftp://forum.example.org', 'http://127.0.0.1:3000', 'http://192.168.1.10', 'http://[::1]/', 'http://localhost:4200', 'http://nas.local', 'http://intranet']) {
      expect((await call('POST', '/sites', { displayName: 'X', baseUrl })).status).toBe(422);
    }
    const added = await call<{ site: { id: string; login: string; progressSource: string; categorySource: string } }>('POST', '/sites', { displayName: 'Meta', baseUrl: 'https://meta.discourse.org/latest' });
    expect(added.status).toBe(201);
    expect(added.body.site).toMatchObject({ id: 'meta-discourse-org', login: 'headed', progressSource: 'none', categorySource: 'discovered', baseUrl: 'https://meta.discourse.org' });
    expect((await call('POST', '/sites', { displayName: 'Meta', baseUrl: 'https://meta.discourse.org' })).status).toBe(409);
    expect((await call('POST', '/profiles', { siteId: 'meta-discourse-org', name: 'main', channel: 'chrome' })).status).toBe(201);
    const again = createApp(appDepsOf(h));
    await again.start();
    const sites = await again.routes.find((r) => r.method === 'GET' && r.path === '/sites')!.handle({ params: {}, query: new URLSearchParams(), body: undefined, ip: '' });
    expect((sites.body as Array<{ site: { id: string } }>).map((s) => s.site.id)).toEqual(['fx', 'meta-discourse-org']);
  });

  it('notifies a run start unless turned off, and a schedule skipped because another process holds the Profile', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    const ws = await events(h);
    const first = (await call<ActiveRun>('POST', '/runs', { presetId: 'p1' })).body.runId;
    expect(h.shell.notices.map(([t]) => t)).toContain('开始运行');
    await call('POST', '/runs/stop');
    await ws.until((f) => f.type === 'run' && f.run.runId === first && f.record !== undefined);
    await call('PUT', '/settings', { notifyOnStart: false });
    h.shell.notices.length = 0;
    const second = (await call<ActiveRun>('POST', '/runs', { presetId: 'p1' })).body.runId;
    await call('POST', '/runs/stop');
    await ws.until((f) => f.type === 'run' && f.run.runId === second && f.record !== undefined);
    expect(h.shell.notices.map(([t]) => t)).not.toContain('开始运行');

    await call('POST', '/profiles/fx/main/inspect');
    await call('PUT', '/schedules/s1', {
      id: 's1',
      name: '夜间',
      profileId: 'fx/main',
      presetId: 'p1',
      enabled: true,
      browserMode: 'headless',
      timezone: 'UTC',
      trigger: { kind: 'cron', expression: '0 8 * * *' },
      misfire: { policy: 'skip', graceMinutes: 30 },
      overlap: 'skip',
      unavailableDisplay: 'skip',
      runOnStart: false,
    });
    // A CLI run in another process holds the Profile's lock file.
    h.locks.set(h.app.services.profiles.dirOf('fx/main'), 4242);
    const skipped = await call<{ error: string }>('POST', '/schedules/s1/trigger');
    expect(skipped.body.error).toBe('skipped-overlap');
    expect(h.shell.notices).toContainEqual(['定时任务已跳过', expect.stringContaining('夜间')]);
    expect((await call<ScheduleHistoryEntry[]>('GET', '/schedules/s1/history')).body.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'overlap' });
    ws.ws.close();
  });

  it('exports a diagnostics bundle with the doctor report, settings, runs and logs, never a token', async () => {
    const h = await boot();
    const call = api(h);
    mkdirSync(join(h.dataDir, 'logs'), { recursive: true });
    writeFileSync(join(h.dataDir, 'logs', 'sidecar-2026-10-09.log'), 'started\nToken (this run only; set LURK_TOKEN to keep one): abcdef123\nAuthorization: Bearer xyz\n');
    const bundle = await call<{ doctor: unknown; settings: unknown; logs: Record<string, string> }>('GET', '/diagnostics');
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('content-disposition')).toMatch(/attachment; filename="disco-lurk-diagnostics-/);
    expect(bundle.body).toMatchObject({ doctor: { checks: [] }, settings: { notifications: true } });
    const log = bundle.body.logs['sidecar-2026-10-09.log']!;
    expect(log).toContain('started');
    expect(log).not.toContain('abcdef123');
    expect(log).not.toContain('xyz');
    const written = await call<{ path: string }>('POST', '/diagnostics');
    expect(existsSync(join(written.body.path, 'summary.json'))).toBe(true);
    expect(readFileSync(join(written.body.path, 'logs', 'sidecar-2026-10-09.log'), 'utf8')).toContain('<redacted>');
  });

  it('answers 409 when another process holds the Profile lock', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    h.locks.set(h.app.services.profiles.dirOf('fx/main'), 4242);
    const res = await call<{ error: string; message: string }>('POST', '/runs', { presetId: 'p1' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'profile-locked' });
    expect((await call('POST', '/profiles/fx/main/login')).status).toBe(409);
    expect((await call('DELETE', '/profiles/fx/main')).status).toBe(409);
  });

  it('walks a sign-in through needs-auth, recheck and the health check, then frees the Profile', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    const ws = await events(h);
    const modes: AuthMode[] = [];
    h.auth.next = async (mode) => (modes.push(mode), mode === 'headed-wait' ? { status: 'needs-auth' } : { status: 'authenticated', username: 'alice' });
    // Only the recheck signs in; the health check after it runs in that same headed window.
    const loginFrame = (phase: string) => (f: ServerFrame) => f.type === 'login' && f.login.phase === phase;
    expect((await call<LoginView>('POST', '/profiles/fx/main/login')).status).toBe(202);
    await ws.until(loginFrame('needs-auth'));
    expect((await call<{ error: string }>('POST', '/runs', { presetId: 'x' })).status).toBe(404);
    await call('PUT', '/presets/p1', { preset: preset() });
    expect((await call<{ error: string }>('POST', '/runs', { presetId: 'p1' })).body.error).toBe('profile-busy');
    await call('POST', '/profiles/fx/main/login/recheck');
    const done = (await ws.until(loginFrame('done'))) as Extract<ServerFrame, { type: 'login' }>;
    expect(done.login).toMatchObject({ username: 'alice', health: { status: 'ready', username: 'alice' } });
    const profiles = await call<Array<{ status: string; busy: boolean }>>('GET', '/profiles');
    expect(profiles.body[0]).toMatchObject({ status: 'ready', busy: false });
    expect(h.opens).toEqual(['headed']);
    expect(modes).toEqual(['headed-wait', 'headless-check', 'headless-check']);
    ws.ws.close();
  });

  it('closing a sign-in releases the Profile', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    // Waits until the window is closed, as the real sign-in check does.
    h.auth.next = (_mode, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    const ws = await events(h);
    await call('POST', '/profiles/fx/main/login');
    const waiting = (await ws.until((f) => f.type === 'login' && f.login.phase === 'waiting')) as Extract<ServerFrame, { type: 'login' }>;
    // The countdown the UI shows ends when the adapter's own wait gives up.
    expect(Math.abs(waiting.login.deadline! - Date.now() - LOGIN_WAIT_MS)).toBeLessThan(5_000);
    const closed = await call<LoginView>('POST', '/profiles/fx/main/login/close');
    expect(closed.body.phase).toBe('closed');
    expect((await call<Array<{ busy: boolean }>>('GET', '/profiles')).body[0]!.busy).toBe(false);
    ws.ws.close();
  });

  it('keeps schedules in files across restarts: cron, pause, resume, run history and preset copies', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset() });
    const spec = {
      id: 's1',
      name: '每天',
      profileId: 'fx/main',
      presetId: 'p1',
      enabled: true,
      browserMode: 'headless',
      timezone: 'Asia/Shanghai',
      trigger: { kind: 'daily-window', runs: 2, start: '00:00', end: '23:59', jitterMinutes: 15, minGapMinutes: 30 },
      misfire: { policy: 'skip', graceMinutes: 30 },
      overlap: 'skip',
      unavailableDisplay: 'skip',
      runOnStart: false,
    };
    // A headless schedule waits for the Profile to pass a health check.
    const unchecked = await call<{ error: string }>('PUT', '/schedules/s1', spec);
    expect(unchecked.status).toBe(428);
    expect(unchecked.body.error).toBe('health-check-required');
    expect((await call('PUT', '/schedules/s1', { ...spec, enabled: false })).status).toBe(200);
    expect((await call('POST', '/profiles/fx/main/inspect')).status).toBe(200);
    const saved = await call<ScheduleList>('PUT', '/schedules/s1', spec);
    expect(saved.status).toBe(200);
    expect(saved.body.available).toBe(true);
    expect(saved.body.schedules[0]!.spec.id).toBe('s1');
    const cron = await call<ScheduleList>('PUT', '/schedules/s1', { ...spec, trigger: { kind: 'cron', expression: '0 8 * * *' } });
    expect(cron.status).toBe(200);
    expect(cron.body.schedules[0]!.next?.plannedAt).toMatch(/T00:00:00\.000Z$/);
    const bad = await call<{ error: string }>('PUT', '/schedules/s1', { ...spec, trigger: { kind: 'cron', expression: '61 * * * *' } });
    expect(bad.body.error).toBe('invalid-trigger');
    expect((await call('PUT', '/schedules/s1', { ...spec, timezone: 'Mars/Base' })).status).toBe(422);

    // The definition and a copy of its preset are what `lurk schedule` reads too.
    const book = () => JSON.parse(readFileSync(join(h.dataDir, 'schedules', 'schedules.json'), 'utf8'));
    expect(book().schedules.map((s: { id: string }) => s.id)).toEqual(['s1']);
    expect(book().presets[0]).toMatchObject({ id: 'p1', browseMode: 'deep' });
    await call('PUT', '/presets/p1', { preset: preset({ browseMode: 'quick' }) });
    expect(book().presets[0]).toMatchObject({ id: 'p1', browseMode: 'quick' });
    expect((await call<{ error: string }>('DELETE', '/presets/p1')).body.error).toBe('preset-in-use');

    const ws = await events(h);
    const fired = await call<{ runId: string }>('POST', '/schedules/s1/trigger');
    expect(fired.status).toBe(202);
    const again = await call<{ error: string }>('POST', '/schedules/s1/trigger');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('skipped-overlap');
    await call('POST', '/runs/stop');
    await ws.until((f) => f.type === 'run' && f.run.runId === fired.body.runId && f.run.result !== undefined);
    const history = async () => (await call<ScheduleHistoryEntry[]>('GET', '/schedules/s1/history')).body;
    await expect.poll(async () => (await history())[0]?.ended?.stopCause).toBe('user');
    expect((await history()).map((e) => e.outcome)).toEqual(['started', 'skipped']);
    expect((await call<ScheduleList>('POST', '/schedules/s1/pause')).body.schedules[0]!.paused).toBe(true);
    expect((await call<{ error: string }>('POST', '/schedules/s1/trigger')).body.error).toBe('skipped-paused');
    expect((await call<ScheduleList>('POST', '/schedules/s1/resume')).body.schedules[0]!.paused).toBe(false);
    await call('POST', '/schedules/s1/pause');
    ws.ws.close();

    // While this app owns the schedules, a second process sees them as unavailable.
    const other = createApp(appDepsOf(h));
    await other.start();
    const otherRoutes = other.routes.find((r) => r.method === 'GET' && r.path === '/schedules')!;
    expect((await otherRoutes.handle({ params: {}, query: new URLSearchParams(), body: undefined, ip: '127.0.0.1' })).body).toMatchObject({ available: false });

    // A restart over the same directory reads the schedule, its paused state and its history back.
    await h.app.close();
    await h.server.close();
    current = undefined;
    const restarted = await boot({ dataDir: h.dataDir });
    const after = await api(restarted)<ScheduleList>('GET', '/schedules');
    await expect.poll(async () => (await api(restarted)<ScheduleList>('GET', '/schedules')).body.schedules.length).toBe(1);
    expect(after.body.available).toBe(true);
    const view = (await api(restarted)<ScheduleList>('GET', '/schedules')).body.schedules[0]!;
    expect(view).toMatchObject({ paused: true, spec: { trigger: { kind: 'cron' } } });
    expect((await api(restarted)<ScheduleHistoryEntry[]>('GET', '/schedules/s1/history')).body).toHaveLength(3);
    expect((await api(restarted)<ScheduleList>('DELETE', '/schedules/s1')).body.schedules).toEqual([]);
    expect(existsSync(join(h.dataDir, 'schedules', '.lurk-lock'))).toBe(true);
  });

  it('saves settings, tells the shell and rotates the token', async () => {
    const h = await boot();
    const call = api(h);
    const put = await call<Settings>('PUT', '/settings', { notifyOnStart: false, notifications: false, historyLimit: 50 });
    expect(put.body).toMatchObject({ notifyOnStart: false, notifications: false, updateCheck: true, historyLimit: 50 });
    expect(h.shell.settings.at(-1)?.notifyOnStart).toBe(false);
    expect((await call('PUT', '/settings', { closeToTray: false })).status).toBe(422);
    expect((await call('PUT', '/settings', { reading: { samplePerCategory: { min: 1, max: 51 }, extraWait: { enabled: true, minSec: 1, maxSec: 3 } } })).status).toBe(422);
    expect((await call('PUT', '/settings', { language: 'en' })).status).toBe(422);

    const rotated = await call<{ token: string }>('POST', '/token/rotate');
    expect(rotated.status).toBe(200);
    expect((await call('GET', '/settings')).status).toBe(401);
    expect((await call('GET', '/settings', undefined, rotated.body.token)).status).toBe(200);
    expect(h.shell.tokens).toEqual([rotated.body.token]);
  });

  it('reports a newer release only while the update check is on', async () => {
    const h = await boot();
    const call = api(h);
    expect((await call('GET', '/update-check')).body).toEqual({ current: '1.2.3', latest: 'v1.3.0', newer: true, releaseUrl: 'https://example.invalid/r' });
    await call('PUT', '/settings', { updateCheck: false });
    expect((await call<{ latest: null }>('GET', '/update-check')).body.latest).toBeNull();
    expect(isNewer('v1.2.10', '1.2.9')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('garbage', '1.0.0')).toBe(false);
  });

  it('forces runs headless and refuses headed sign-in without a display', async () => {
    const h = await boot({ headlessOnly: true });
    const call = api(h);
    expect((await call<{ headlessOnly: boolean }>('GET', '/info')).body.headlessOnly).toBe(true);
    await withProfile(h);
    await call('PUT', '/presets/p1', { preset: preset({ browserMode: 'headed' }) });
    expect((await call<{ error: string }>('POST', '/profiles/fx/main/login')).body.error).toBe('no-display');
    const run = await call<ActiveRun>('POST', '/runs', { presetId: 'p1' });
    expect(run.body.plan.browserMode).toBe('headless');
    await call('POST', '/runs/stop');
  });

  it('answers /shutdown before shutting down, and creates, edits and deletes Profiles', async () => {
    const h = await boot();
    const call = api(h);
    await withProfile(h);
    expect((await call('POST', '/profiles', { siteId: 'fx', name: 'main', channel: 'chrome' })).status).toBe(409);
    expect((await call('POST', '/profiles', { siteId: 'fx', name: '../x', channel: 'chrome' })).status).toBe(422);
    expect((await call('PATCH', '/profiles/fx/main', { proxy: 'http://127.0.0.1:7890' })).status).toBe(200);
    expect((await call('PATCH', '/profiles/fx/main', { executablePath: '/bin/sh' })).status).toBe(422);
    expect((await call('PATCH', '/profiles/fx/main', { proxy: '--disable-web-security' })).status).toBe(422);
    const withCredentials = await call<{ message: string }>('PATCH', '/profiles/fx/main', { proxy: 'http://user:secret@127.0.0.1:7890' });
    expect(withCredentials.status).toBe(422);
    expect(withCredentials.body.message).toMatch(/credentials are not supported/);
    expect(await h.app.services.profiles.resolve('fx/main')).toMatchObject({ channel: 'chrome', proxy: 'http://127.0.0.1:7890' });
    mkdirSync(join(h.dataDir, 'profiles', 'fx', 'cli-made'), { recursive: true });
    expect((await call<Array<{ id: string }>>('GET', '/profiles')).body.map((p) => p.id)).toEqual(['fx/cli-made', 'fx/main']);
    const backup = await call<{ path: string }>('POST', '/profiles/fx/main/backup');
    expect(backup.body.path).toContain(join(h.dataDir, 'backups'));
    expect((await call('DELETE', '/profiles/fx/main')).status).toBe(204);
    expect((await call('POST', '/shutdown')).status).toBe(202);
    expect(h.shutdowns()).toBe(1);
  });
});

/** Reads the history file as a fresh process would. */
class RunHistoryProbe {
  constructor(private readonly h: Harness) {}
  async list() {
    const history = new RunHistory(join(this.h.dataDir, 'runs'));
    await history.load();
    return history.list();
  }
}

/** The dependencies of a running harness, for a second app over the same data directory. */
function appDepsOf(h: Harness): Parameters<typeof createApp>[0] {
  return {
    version: '1.2.3',
    clock: systemClock,
    dataDir: h.dataDir,
    profilesDir: join(h.dataDir, 'profiles'),
    coordinator: new DiscoLurkCoordinator({
      deps: { clock: systemClock, random: seededRandom(1), sleeper: fastSleeper },
      categories: new MemoryCategories(),
      resolveProfile: async () => {
        throw new Error('unused');
      },
      open: async () => {
        throw new Error('unused');
      },
    }),
    sites: [site],
    categories: new MemoryCategories(),
    lockHolder: async () => null,
    doctor: async () => null,
    shutdown: async () => {},
    displayAvailable: () => true,
  };
}
