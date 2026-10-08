import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LOOPBACK_FAILURE_DELAY_MS, startServer, WS_AUTH_TIMEOUT_MS, WS_CLOSE, type LurkServer } from './server';

const token = () => randomBytes(32).toString('base64url');

let server: LurkServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(opts: { wsAuthTimeoutMs?: number; loopbackFailureDelayMs?: number } = {}) {
  const clock = { ms: Date.UTC(2026, 9, 8) };
  const t = token();
  let shutdowns = 0;
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: t,
    version: '0.0.0-test',
    clock: { now: () => clock.ms, monotonic: () => clock.ms },
    handlers: { doctor: async () => ({ checks: [] }), shutdown: async () => void shutdowns++ },
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { clock, token: t, base, server, shutdowns: () => shutdowns };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function openWs(base: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/events');
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })));
  const messages: unknown[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = () => new Promise<unknown>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
  return { ws, opened, closed, messages, next };
}

describe('SERVER-001 sidecar access contract (§10.3)', () => {
  it('serves /health without a token', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.0-test' });
  });

  it('rejects writes and protected reads without a valid bearer token', async () => {
    const { base, token: t, shutdowns } = await boot();
    expect((await fetch(`${base}/shutdown`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/shutdown`, { method: 'POST', headers: auth('nope') })).status).toBe(401);
    expect((await fetch(`${base}/shutdown?token=${t}`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/doctor`)).status).toBe(401);
    expect(shutdowns()).toBe(0);
    expect((await fetch(`${base}/doctor`, { headers: auth(t) })).status).toBe(200);
    expect((await fetch(`${base}/shutdown`, { method: 'POST', headers: auth(t) })).status).toBe(202);
    expect(shutdowns()).toBe(1);
  });

  it('returns CORS headers only for the Tauri origins', async () => {
    const { base } = await boot();
    for (const origin of ['tauri://localhost', 'http://tauri.localhost']) {
      const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const foreign = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/doctor`, {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('refuses tokens shorter than 32 bytes', async () => {
    await expect(
      startServer({
        host: '127.0.0.1',
        port: 0,
        token: 'short',
        version: 'x',
        clock: { now: () => 0, monotonic: () => 0 },
        handlers: { doctor: async () => null, shutdown: async () => {} },
      }),
    ).rejects.toThrow(/32 bytes/);
  });

  it('streams events only after a valid first-frame auth', async () => {
    const { base, token: t, server: s } = await boot();
    const good = openWs(base);
    const idle = openWs(base);
    await Promise.all([good.opened, idle.opened]);
    good.ws.send(JSON.stringify({ type: 'auth', token: t }));
    expect(await good.next()).toEqual({ type: 'auth-ok' });
    s.broadcast({ type: 'warning', at: 'now', code: 'x', message: 'hello' });
    expect(await good.next()).toMatchObject({ type: 'event', event: { code: 'x' } });
    expect(idle.messages).toEqual([]);
    good.ws.close();
    idle.ws.close();
  });

  it('closes a socket whose first frame is not a valid auth frame', async () => {
    const { base } = await boot();
    const wrong = openWs(base);
    await wrong.opened;
    wrong.ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect((await wrong.closed).code).toBe(WS_CLOSE.authFailed);
    const notAuth = openWs(base);
    await notAuth.opened;
    notAuth.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await notAuth.closed).code).toBe(WS_CLOSE.authFailed);
  });

  it('closes a socket that sends nothing within the auth timeout (5 s in production)', async () => {
    expect(WS_AUTH_TIMEOUT_MS).toBe(5000);
    const { base } = await boot({ wsAuthTimeoutMs: 150 });
    const silent = openWs(base);
    await silent.opened;
    expect((await silent.closed).code).toBe(WS_CLOSE.authTimeout);
  });

  it('rotation invalidates the old token at once and drops every socket', async () => {
    const { base, token: old, server: s } = await boot();
    const ws = openWs(base);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: 'auth', token: old }));
    await ws.next();
    const fresh = token();
    s.rotateToken(fresh);
    expect((await ws.closed).code).toBe(WS_CLOSE.tokenRotated);
    expect((await fetch(`${base}/doctor`, { headers: auth(old) })).status).toBe(401);
    expect((await fetch(`${base}/doctor`, { headers: auth(fresh) })).status).toBe(200);
  });

  it('never locks out loopback: after 20 wrong tokens the right one still works, each failure delayed', async () => {
    expect(LOOPBACK_FAILURE_DELAY_MS).toBeGreaterThan(0);
    const { base, token: t } = await boot({ loopbackFailureDelayMs: 40 });
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      expect((await fetch(`${base}/doctor`, { headers: auth('bad') })).status).toBe(401);
      expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    }
    expect((await fetch(`${base}/doctor`, { headers: auth(t) })).status).toBe(200);
    const ws = openWs(base);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: 'auth', token: t }));
    expect(await ws.next()).toEqual({ type: 'auth-ok' });
    ws.ws.close();
  });
});
