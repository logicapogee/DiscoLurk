import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { processAlive } from '@disco-lurk/config';
import { acquireProfileLock, LOCK_FILE } from '@disco-lurk/site-discourse';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { SidecarLifecycle, SHUTDOWN_BUDGET_MS } from './lifecycle';

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe('sidecar lifecycle (§10.4)', () => {
  it('stdin EOF runs the same cleanup as /shutdown and releases Profile locks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lurk-life-'));
    const lifecycle = new SidecarLifecycle();
    const lock = await acquireProfileLock(dir, 'run-1');
    lifecycle.register(`profile lock ${dir}`, () => lock.release());
    const stdin = new PassThrough();
    lifecycle.watchParent(stdin);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    stdin.end();
    await lifecycle.done;
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('runs cleanups once, newest first, whichever trigger comes first', async () => {
    const order: string[] = [];
    const lifecycle = new SidecarLifecycle();
    lifecycle.register('locks', async () => void order.push('locks'));
    lifecycle.register('browsers', async () => void order.push('browsers'));
    lifecycle.register('sessions', async () => void order.push('sessions'));
    await Promise.all([lifecycle.shutdown('/shutdown request'), lifecycle.shutdown('stdin closed')]);
    expect(order).toEqual(['sessions', 'browsers', 'locks']);
  });

  it('keeps cleaning up after one cleanup fails, and gives up after the budget', async () => {
    const logs: string[] = [];
    const lifecycle = new SidecarLifecycle((m) => logs.push(m), 50);
    let released = false;
    lifecycle.register('lock', async () => void (released = true));
    lifecycle.register('hung', () => new Promise(() => {}));
    lifecycle.register('broken', async () => {
      throw new Error('boom');
    });
    await lifecycle.shutdown('SIGTERM');
    expect(logs.some((l) => l.includes('broken failed'))).toBe(true);
    expect(logs.some((l) => l.includes('exceeded 50 ms'))).toBe(true);
    expect(released).toBe(false);
    expect(SHUTDOWN_BUDGET_MS).toBe(15_000);
  });

  it('skips unregistered cleanups', async () => {
    const lifecycle = new SidecarLifecycle();
    let ran = false;
    const unregister = lifecycle.register('gone', async () => void (ran = true));
    unregister();
    await lifecycle.shutdown('SIGINT');
    expect(ran).toBe(false);
  });
});

describe('sidecar lifecycle with real processes (§10.4)', () => {
  // A stand-in shell owns the sidecar's stdin pipe; SIGKILL gives it no chance to call /shutdown,
  // so only the kernel closing that pipe can tell the sidecar to clean up.
  it('kill -9 of the parent makes the child exit and release its Profile lock', async () => {
    const work = mkdtempSync(join(tmpdir(), 'lurk-kill9-'));
    const profile = join(work, 'profile');
    const entry = join(work, 'sidecar-entry.ts');
    const here = fileURLToPath(new URL('.', import.meta.url));
    writeFileSync(
      entry,
      `import { mkdirSync } from 'node:fs';
import { acquireProfileLock } from ${JSON.stringify(join(here, '../../site-discourse/src/profile-lock.ts'))};
import { SidecarLifecycle } from ${JSON.stringify(join(here, 'lifecycle.ts'))};
const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
const lifecycle = new SidecarLifecycle();
const lock = await acquireProfileLock(dir, 'kill9');
lifecycle.register('profile lock', () => lock.release());
lifecycle.watchParent(process.stdin);
console.log('ready');
await lifecycle.done;
process.exit(0);
`,
    );
    const bundle = join(work, 'sidecar.mjs');
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', nodePaths: [join(here, '../node_modules')] });
    const shell = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, [${JSON.stringify(bundle)}, ${JSON.stringify(profile)}], { stdio: ['pipe', 'pipe', 'inherit'] });
c.stdout.on('data', (d) => { if (String(d).includes('ready')) console.log(String(c.pid)); });
setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', shell], { stdio: ['ignore', 'pipe', 'inherit'] });
    const childPid = await new Promise<number>((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    const lockPath = join(profile, LOCK_FILE);
    expect(existsSync(lockPath)).toBe(true);
    expect(processAlive(childPid)).toBe(true);

    process.kill(parent.pid!, 'SIGKILL');
    expect(await until(() => !processAlive(childPid), 5_000)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);
});
