import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAlive } from '@disco-lurk/config';
import { LOCK_FILE } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { exitOnCrash } from './lifecycle';
import { parseServeArgs, runLogLine, serveToken } from './serve';
import { reclaimProfiles } from './sidecar';

const strong = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

describe('lurk serve access rules', () => {
  it('refuses a non-loopback host without LURK_TOKEN and a weak LURK_TOKEN anywhere', () => {
    expect(() => serveToken('0.0.0.0', {})).toThrow(/LURK_TOKEN is required/);
    expect(() => serveToken('192.168.1.5', {})).toThrow(/LURK_TOKEN is required/);
    expect(() => serveToken('0.0.0.0', { LURK_TOKEN: 'short' })).toThrow(/at least 32 bytes/);
    expect(() => serveToken('127.0.0.1', { LURK_TOKEN: 'short' })).toThrow(/at least 32 bytes/);
    expect(serveToken('0.0.0.0', { LURK_TOKEN: strong })).toEqual({ token: strong, minted: false });
  });

  it('mints its own token on loopback when none is given', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
      const t = serveToken(host, {});
      expect(t.minted).toBe(true);
      expect(Buffer.byteLength(t.token)).toBeGreaterThanOrEqual(32);
    }
  });

  it('defaults to loopback:8080 and takes the data and UI directories from flags or the environment', () => {
    const a = parseServeArgs([], { LURK_DATA_DIR: '/data', LURK_UI_DIR: '/ui' });
    expect(a).toMatchObject({ host: '127.0.0.1', port: 8080, headless: false, dataDir: '/data', uiDir: '/ui' });
    const b = parseServeArgs(['--host', '0.0.0.0', '--port', '9000', '--headless', '--data', '/x', '--origin', 'https://a', '--origin', 'https://b'], {});
    expect(b).toMatchObject({ host: '0.0.0.0', port: 9000, headless: true, dataDir: '/x', origins: ['https://a', 'https://b'] });
    expect(() => parseServeArgs(['--port', 'nope'], {})).toThrow(/Invalid --port/);
    expect(parseServeArgs([], { LURK_PORT: '9090' }).port).toBe(9090);
    expect(parseServeArgs(['--port', '9000'], { LURK_PORT: '9090' }).port).toBe(9000);
    expect(parseServeArgs(['--trusted-proxy', '10.0.0.2'], { LURK_TRUSTED_PROXIES: '10.0.0.3, 10.0.0.4' }).trustedProxies).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4']);
    expect(a.trustedProxies).toEqual([]);
  });
});

describe('crashes in serve and sidecar', () => {
  it('runs the shutdown once for an unhandled rejection or exception, then exits with the environment code', async () => {
    const target = new EventEmitter();
    const reasons: string[] = [];
    const logs: string[] = [];
    let exitCode: number | null = null;
    await new Promise<void>((resolve) => {
      const watch = exitOnCrash(
        { shutdown: async (r) => void reasons.push(r) },
        (m) => logs.push(m),
        4,
        target,
        (code) => {
          exitCode = code;
          resolve();
        },
      );
      target.emit('unhandledRejection', new Error('history write failed'));
      target.emit('uncaughtException', new Error('second'));
      expect(watch.crashed).toBe(true);
    });
    expect(reasons).toEqual(['unhandledRejection']);
    expect(exitCode).toBe(4);
    expect(logs[0]).toMatch(/^unhandledRejection: Error: history write failed/);
    expect(logs[1]).toMatch(/^uncaughtException: Error: second/);
  });
});

describe('lurk serve log', () => {
  it('keeps warnings, errors and how each run ended', () => {
    const at = '2026-10-09T00:00:00.000Z';
    expect(runLogLine({ type: 'event', runId: 'r1', event: { seq: 1, type: 'warning', at, code: 'page-hidden', message: 'hidden' } })).toBe('r1 warning page-hidden: hidden');
    expect(runLogLine({ type: 'event', runId: 'r1', event: { seq: 2, type: 'error', at, error: { code: 'needs-auth', message: 'signed out' } } })).toBe('r1 error needs-auth: signed out');
    expect(runLogLine({ type: 'event', runId: 'r1', event: { seq: 3, type: 'floor', at, from: 1, to: 2, confirmed: true } })).toBeNull();
    const stats = { confirmed: { topics: 3, floors: 40 } } as never;
    const run = { runId: 'r1', presetName: 'p', plan: { profileId: 'linuxdo/default' }, state: 'completed', result: { outcome: 'completed', stopCause: 'target', stats } } as never;
    expect(runLogLine({ type: 'run', run })).toBe('run r1 ended: completed (target), confirmed 3 topics / 40 floors');
  });
});

describe.skipIf(process.platform === 'win32')('reclaiming Profiles a dead sidecar left behind', () => {
  it('kills browsers still using a stale-locked Profile and removes the lock; live locks stay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lurk-reclaim-'));
    const stale = join(root, 'site', 'stale');
    const live = join(root, 'site', 'live');
    mkdirSync(stale, { recursive: true });
    mkdirSync(live, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    expect(processAlive(dead)).toBe(false);
    writeFileSync(join(stale, LOCK_FILE), JSON.stringify({ pid: dead, startedAt: 'x', runId: 'r' }));
    // A live process other than this one: a lock naming this PID that it does not hold is stale.
    writeFileSync(join(live, LOCK_FILE), JSON.stringify({ pid: process.ppid, startedAt: 'x', runId: 'r' }));
    // Stands in for the Chrome that the dead sidecar launched on that Profile.
    const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${stale}`], { stdio: 'ignore' });
    const exited = new Promise((r) => browser.once('exit', r));
    await new Promise((r) => setTimeout(r, 200));
    const logs: string[] = [];
    await reclaimProfiles(root, ['site', 'absent'], (m) => logs.push(m));
    await exited;
    expect(existsSync(join(stale, LOCK_FILE))).toBe(false);
    expect(existsSync(join(live, LOCK_FILE))).toBe(true);
    expect(logs.join('\n')).toContain(`killed browsers ${browser.pid}`);
  });
});
