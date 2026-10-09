import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCredentialsEnv, ENV_SCHEDULE_ID, EnvError, envSchedule, envWarnings, proxyFromEnv, runArgvWithEnv, serveEnv } from './env';
import { parseRunArgs } from './run';

const TOKEN = 'x'.repeat(43);

describe('lurk run reads LURK_* for options the command line leaves out', () => {
  const parsed = (argv: string[], env: Record<string, string>) => parseRunArgs(runArgvWithEnv(argv, env));

  it.each([
    ['LURK_SITE', { LURK_SITE: 'docofcard' }, (a: ReturnType<typeof parseRunArgs>) => a.site.id, 'docofcard', ['--site', 'linuxdo'], 'linuxdo'],
    ['LURK_BROWSE_MODE', { LURK_BROWSE_MODE: 'quick' }, (a: ReturnType<typeof parseRunArgs>) => a.browseMode, 'quick', ['--browse-mode', 'deep'], 'deep'],
    ['LURK_RUN_MODE', { LURK_RUN_MODE: 'topics:15-40' }, (a: ReturnType<typeof parseRunArgs>) => a.runMode, { kind: 'topics', min: 15, max: 40 }, ['--run-mode=time:5'], { kind: 'time', minutes: 5 }],
    ['LURK_CATEGORIES', { LURK_CATEGORIES: 'develop, bank' }, (a: ReturnType<typeof parseRunArgs>) => a.categories, ['develop', 'bank'], ['--categories', 'news'], ['news']],
    ['LURK_LIKE_RATE', { LURK_LIKE_RATE: '45' }, (a: ReturnType<typeof parseRunArgs>) => a.interaction.like.topicRate, 45, ['--like-rate', '10'], 10],
  ])('%s fills in, an explicit option wins', (_name, env, pick, fromEnv, argv, fromArgv) => {
    expect(pick(parsed([], env))).toEqual(fromEnv);
    expect(pick(parsed(argv, env))).toEqual(fromArgv);
  });

  it('LURK_LIKE turns likes on; unset or false leaves the default off', () => {
    expect(parsed([], { LURK_LIKE: 'true' }).interaction.like.enabled).toBe(true);
    expect(parsed([], { LURK_LIKE: 'false' }).interaction.like.enabled).toBe(false);
    expect(parsed([], {}).interaction.like.enabled).toBe(false);
    expect(parsed(['--like'], { LURK_LIKE: '1' }).interaction.like.enabled).toBe(true);
  });

  it('treats empty values as unset, as compose files pass them', () => {
    expect(runArgvWithEnv(['--headless'], { LURK_SITE: '', LURK_RUN_MODE: ' ', LURK_PROXY: '' })).toEqual(['--headless']);
  });

  it.each([
    [{ LURK_SITE: 'nowhere' }, /LURK_SITE=nowhere is not a known site/],
    [{ LURK_BROWSE_MODE: 'fast' }, /LURK_BROWSE_MODE must be deep or quick/],
    [{ LURK_RUN_MODE: 'topics:0' }, /LURK_RUN_MODE/],
    [{ LURK_LIKE: 'maybe' }, /LURK_LIKE must be true or false/],
    [{ LURK_LIKE_RATE: '120' }, /LURK_LIKE_RATE must be a percentage/],
    [{ LURK_USERNAME: 'me' }, /LURK_USERNAME and LURK_PASSWORD must be set together; only LURK_USERNAME/],
    [{ LURK_PROXY: 'not a url' }, /LURK_PROXY must be a URL/],
    [{ LURK_PROXY: 'ftp://h:1' }, /scheme must be http, https or socks5/],
  ])('rejects %o as an environment error', (env, message) => {
    expect(() => runArgvWithEnv([], env)).toThrow(EnvError);
    expect(() => runArgvWithEnv([], env)).toThrow(message);
  });

  it('reads LURK_PROXY and both credentials together', () => {
    expect(proxyFromEnv({ LURK_PROXY: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080');
    expect(() => checkCredentialsEnv({ LURK_USERNAME: 'me', LURK_PASSWORD: 'pw' })).not.toThrow();
  });
});

describe('reply variables', () => {
  it('reports LURK_REPLY* as unsupported and keeps replies off', () => {
    expect(envWarnings({})).toEqual([]);
    expect(envWarnings({ LURK_REPLY: '' })).toEqual([]);
    expect(envWarnings({ LURK_REPLY: 'true', LURK_REPLY_RATE: '5' })).toEqual([
      expect.stringMatching(/^LURK_REPLY is not supported/),
      expect.stringMatching(/^LURK_REPLY_RATE is not supported/),
    ]);
    expect(parseRunArgs(runArgvWithEnv([], { LURK_REPLY: 'true' })).interaction.reply.enabled).toBe(false);
    expect(envSchedule({ LURK_RUNS_PER_DAY: '1', LURK_REPLY: 'true' }, 'UTC')!.preset.interaction.reply).toMatchObject({ enabled: false, riskAcknowledged: false });
  });
});

describe('lurk serve environment', () => {
  it('requires a strong LURK_TOKEN beyond loopback', () => {
    expect(() => serveEnv('0.0.0.0', {})).toThrow(/LURK_TOKEN is required/);
    expect(() => serveEnv('0.0.0.0', { LURK_TOKEN: 'short' })).toThrow(/at least 32 bytes/);
    expect(serveEnv('0.0.0.0', { LURK_TOKEN: TOKEN }).token).toBe(TOKEN);
    expect(serveEnv('127.0.0.1', {}).token).toBeUndefined();
  });

  it('defines no schedule unless LURK_RUNS_PER_DAY is above zero', () => {
    expect(envSchedule({}, 'UTC')).toBeNull();
    expect(envSchedule({ LURK_RUNS_PER_DAY: '0' }, 'UTC')).toBeNull();
  });

  it('builds the schedule from the defaults the variable table gives', () => {
    const s = envSchedule({ LURK_RUNS_PER_DAY: '2' }, 'Asia/Shanghai')!;
    expect(s.spec).toMatchObject({
      id: ENV_SCHEDULE_ID,
      profileId: 'linuxdo/default',
      browserMode: 'headless',
      timezone: 'Asia/Shanghai',
      trigger: { kind: 'daily-window', runs: 2, start: '07:00', end: '23:00', jitterMinutes: 15 },
      runOnStart: true,
    });
    expect(s.preset).toMatchObject({ siteId: 'linuxdo', browseMode: 'deep', runMode: { kind: 'topics', min: 15, max: 40 } });
    expect(s.preset.interaction.like).toMatchObject({ enabled: false, topicRate: 30 });
    expect(s.categoryTokens).toBeNull();
  });

  it('takes every scheduling variable', () => {
    const s = envSchedule(
      {
        LURK_RUNS_PER_DAY: '3',
        LURK_WINDOW: '08:30-22:15',
        LURK_JITTER_MIN: '5',
        LURK_RUN_ON_START: 'false',
        LURK_SITE: 'docofcard',
        LURK_BROWSE_MODE: 'quick',
        LURK_RUN_MODE: 'time:20',
        LURK_LIKE: 'true',
        LURK_LIKE_RATE: '12',
        LURK_CATEGORIES: 'bank,/c/card/7',
        TZ: 'Europe/Berlin',
      },
      'UTC',
    )!;
    expect(s.spec).toMatchObject({
      profileId: 'docofcard/default',
      timezone: 'Europe/Berlin',
      trigger: { runs: 3, start: '08:30', end: '22:15', jitterMinutes: 5 },
      runOnStart: false,
    });
    expect(s.preset).toMatchObject({ siteId: 'docofcard', browseMode: 'quick', runMode: { kind: 'time', minutes: 20 } });
    expect(s.preset.interaction.like).toMatchObject({ enabled: true, topicRate: 12 });
    expect(s.categoryTokens).toEqual(['bank', '/c/card/7']);
  });

  it.each([
    [{ LURK_RUNS_PER_DAY: 'two' }, /LURK_RUNS_PER_DAY must be a whole number/],
    [{ LURK_RUNS_PER_DAY: '2', LURK_WINDOW: '7-23' }, /LURK_WINDOW must be HH:MM-HH:MM/],
    [{ LURK_RUNS_PER_DAY: '2', LURK_JITTER_MIN: '-1' }, /LURK_JITTER_MIN must be a whole number/],
    [{ LURK_RUNS_PER_DAY: '2', LURK_RUN_ON_START: 'later' }, /LURK_RUN_ON_START must be true or false/],
  ])('rejects %o', (env, message) => {
    expect(() => envSchedule(env, 'UTC')).toThrow(message);
  });
});

describe('the lurk binary with LURK_* set', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  // Inside packages/cli, so the external playwright-core resolves from this package's dependencies.
  const bundle = join(root, 'packages/cli/dist', `env-test-${process.pid}.cjs`);

  beforeAll(async () => {
    await build({
      entryPoints: [join(root, 'packages/cli/src/main.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['bufferutil', 'utf-8-validate', 'chromium-bidi/*', 'playwright-core'],
      logLevel: 'silent',
    });
  }, 60_000);
  afterAll(() => rmSync(bundle, { force: true }));

  function lurk(args: string[], env: Record<string, string>, until?: (stderr: string) => boolean) {
    const home = mkdtempSync(join(tmpdir(), 'lurk-env-home-'));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LURK_')));
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...clean, HOME: home, XDG_DATA_HOME: join(home, 'data'), APPDATA: join(home, 'appdata'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const ready = new Promise<void>((resolve) => {
      child.stderr.on('data', (d: Buffer) => {
        stderr += d;
        if (until?.(stderr)) resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    return { child, home, ready, exited, stderr: () => stderr };
  }

  it.each([
    [['serve', '--host', '0.0.0.0'], {}, /LURK_TOKEN is required/],
    [['serve', '--host', '0.0.0.0'], { LURK_TOKEN: 'short' }, /at least 32 bytes/],
    [['run', '--headless'], { LURK_BROWSE_MODE: 'fast' }, /LURK_BROWSE_MODE must be deep or quick/],
    [['run', '--headless'], { LURK_PASSWORD: 'pw' }, /only LURK_PASSWORD is set/],
    [['serve'], { LURK_RUNS_PER_DAY: 'many' }, /LURK_RUNS_PER_DAY must be a whole number/],
  ])('%j with %o exits with the environment code', async (args, env, message) => {
    const p = lurk(args, env);
    expect(await p.exited).toBe(4);
    expect(p.stderr()).toMatch(message);
  });

  it('serve plans the LURK_* schedule, answers /health and stops cleanly on SIGTERM', async () => {
    const p = lurk(['serve', '--host', '127.0.0.1', '--port', '0', '--headless'], { LURK_TOKEN: TOKEN, LURK_RUNS_PER_DAY: '1', LURK_WINDOW: '00:00-23:59', LURK_RUN_ON_START: 'false', LURK_REPLY: 'true', TZ: 'UTC' }, (s) =>
      /listening on http:\/\/127\.0\.0\.1:(\d+)/.test(s),
    );
    await p.ready;
    const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(p.stderr())![1]);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(p.stderr()).toMatch(/warning: LURK_REPLY is not supported/);
    // The same server answers the schedule API with the LURK_* schedule it plans.
    const auth = { Authorization: `Bearer ${TOKEN}` };
    let listed: { available: boolean; schedules: Array<{ spec: { id: string } }> } = { available: false, schedules: [] };
    for (let i = 0; i < 50 && listed.schedules.length === 0; i++) {
      listed = (await (await fetch(`http://127.0.0.1:${port}/schedules`, { headers: auth })).json()) as typeof listed;
      if (listed.schedules.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(listed).toMatchObject({ available: true, schedules: [{ spec: { id: ENV_SCHEDULE_ID } }] });
    const stateFile = process.platform === 'darwin' ? join(p.home, 'Library/Application Support/disco-lurk/schedules/state.json') : process.platform === 'win32' ? join(p.home, 'appdata/disco-lurk/schedules/state.json') : join(p.home, 'data/disco-lurk/schedules/state.json');
    for (let i = 0; i < 50; i++) {
      try {
        readFileSync(stateFile);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.schedules[ENV_SCHEDULE_ID].generatedDays).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(state.schedules[ENV_SCHEDULE_ID].runOnStartConsumed).toBe(false);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
  }, 30_000);
});
