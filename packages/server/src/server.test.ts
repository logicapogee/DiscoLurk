import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventHub, LOOPBACK_FAILURE_DELAY_MS, startServer, WS_AUTH_TIMEOUT_MS, WS_CLOSE, WS_MAX_PAYLOAD, type LurkServer, type Route } from './server';

const token = () => randomBytes(32).toString('base64url');

let server: LurkServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(
  opts: { wsAuthTimeoutMs?: number; loopbackFailureDelayMs?: number; heartbeatMs?: number; staticDir?: string; trustedProxies?: string[]; wsMaxUnauthenticated?: number; log?: (m: string) => void } = {},
) {
  const clock = { ms: Date.UTC(2026, 9, 8) };
  const t = token();
  let shutdowns = 0;
  const hub = new EventHub();
  const routes: Route[] = [
    { method: 'GET', path: '/doctor', handle: async () => ({ status: 200, body: { checks: [] } }) },
    { method: 'POST', path: '/shutdown', handle: async () => ({ status: 202, after: () => void shutdowns++ }) },
    { method: 'PUT', path: '/things/:id', handle: async ({ params, body }) => ({ status: 200, body: { id: params.id, body } }) },
    {
      method: 'GET',
      path: '/boom',
      handle: async () => {
        throw new Error('ENOENT: /home/alice/secret/path');
      },
    },
  ];
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: t,
    version: '0.0.0-test',
    clock: { now: () => clock.ms, monotonic: () => clock.ms },
    routes,
    hub,
    ...opts,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { clock, token: t, base, server, hub, shutdowns: () => shutdowns };
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
        routes: [],
      }),
    ).rejects.toThrow(/32 bytes/);
  });

  it('streams events only after a valid first-frame auth', async () => {
    const { base, token: t, hub } = await boot();
    const good = openWs(base);
    const idle = openWs(base);
    await Promise.all([good.opened, idle.opened]);
    good.ws.send(JSON.stringify({ type: 'auth', token: t }));
    expect(await good.next()).toEqual({ type: 'auth-ok' });
    hub.publish({ type: 'event', runId: 'r1', event: { seq: 1, type: 'warning', at: 'now', code: 'x', message: 'hello' } });
    expect(await good.next()).toMatchObject({ type: 'event', runId: 'r1', event: { code: 'x' } });
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

  it('locks out a non-loopback source after 5 failures, over real HTTP', async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) return; // no external interface on this machine; TokenGuard tests cover the rule
    const t = token();
    server = await startServer({
      host: '0.0.0.0',
      port: 0,
      token: t,
      version: 'x',
      clock: { now: () => Date.now(), monotonic: () => performance.now() },
      routes: [{ method: 'GET', path: '/doctor', handle: async () => ({ status: 200, body: {} }) }],
    });
    const base = `http://${lan}:${server.port}`;
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/doctor`, { headers: auth('bad') })).status).toBe(401);
    expect((await fetch(`${base}/doctor`, { headers: auth('bad') })).status).toBe(429);
    expect((await fetch(`${base}/doctor`, { headers: auth(t) })).status).toBe(429);
    expect((await fetch(`http://127.0.0.1:${server.port}/doctor`, { headers: auth(t) })).status).toBe(200);
  });

  it('routes by method and path parameters and parses JSON bodies', async () => {
    const { base, token: t } = await boot();
    const res = await fetch(`${base}/things/a%2Fb`, { method: 'PUT', headers: { ...auth(t), 'Content-Type': 'application/json' }, body: '{"x":1}' });
    expect(await res.json()).toEqual({ id: 'a/b', body: { x: 1 } });
    expect((await fetch(`${base}/things/a`, { method: 'PUT', headers: auth(t), body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/things/a`, { method: 'POST', headers: auth(t) })).status).toBe(405);
    expect((await fetch(`${base}/nothing`, { headers: auth(t) })).status).toBe(404);
    expect((await fetch(`${base}/things/a`, { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('serves the static UI without a token and never outside its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lurk-ui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ui</title>');
    const { base } = await boot({ staticDir: dir });
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(index.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('sends heartbeats to authenticated sockets', async () => {
    const { base, token: t } = await boot({ heartbeatMs: 50 });
    const ws = openWs(base);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: 'auth', token: t }));
    await ws.next();
    expect(await ws.next()).toMatchObject({ type: 'heartbeat' });
    ws.ws.close();
  });

  it('answers an internal error without its message, and logs the details', async () => {
    const logs: string[] = [];
    const { base, token: t } = await boot({ log: (m) => logs.push(m) });
    const res = await fetch(`${base}/boom`, { headers: auth(t) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(logs.join('\n')).toContain('/home/alice/secret/path');
  });

  it('answers 400 for a static path that is not valid percent-encoding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lurk-ui-'));
    writeFileSync(join(dir, 'index.html'), 'ui');
    const { base } = await boot({ staticDir: dir });
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
  });
});

describe('SERVER-001 WebSocket hardening', () => {
  it('survives oversized and malformed frames and keeps serving', async () => {
    const logs: string[] = [];
    const { base, token: t } = await boot({ log: (m) => logs.push(m) });
    const big = openWs(base);
    await big.opened;
    big.ws.on('error', () => {});
    big.ws.send('x'.repeat(WS_MAX_PAYLOAD + 1));
    expect((await big.closed).code).toBe(1009);

    // A frame with the reserved bits set, written straight onto the upgraded TCP socket.
    const raw = await new Promise<Socket>((resolve, reject) => {
      const sock = connect(Number(new URL(base).port), '127.0.0.1', () => {
        sock.write(
          'GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
        sock.once('data', () => resolve(sock));
      });
      sock.on('error', reject);
    });
    const closed = new Promise<void>((resolve) => raw.on('close', () => resolve()));
    raw.on('error', () => {});
    raw.write(Buffer.from([0xf1, 0x80, 0, 0, 0, 0]));
    await closed;

    const good = openWs(base);
    await good.opened;
    good.ws.send(JSON.stringify({ type: 'auth', token: t }));
    expect(await good.next()).toEqual({ type: 'auth-ok' });
    good.ws.close();
    expect(logs.some((l) => l.startsWith('ws '))).toBe(true);
  });

  it('refuses a browser origin that is neither allowed nor the server itself', async () => {
    const { base } = await boot();
    const foreign = new WebSocket(base.replace('http', 'ws') + '/events', { origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => foreign.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
    for (const origin of ['tauri://localhost', base]) {
      const ok = new WebSocket(base.replace('http', 'ws') + '/events', { origin });
      await new Promise<void>((resolve, reject) => {
        ok.once('open', () => resolve());
        ok.once('error', reject);
      });
      ok.close();
    }
  });

  it('caps the sockets still waiting for their auth frame', async () => {
    const { base, token: t } = await boot({ wsMaxUnauthenticated: 2 });
    const a = openWs(base);
    const b = openWs(base);
    await Promise.all([a.opened, b.opened]);
    const c = new WebSocket(base.replace('http', 'ws') + '/events');
    await new Promise<void>((resolve) => c.on('unexpected-response', () => resolve()));
    a.ws.send(JSON.stringify({ type: 'auth', token: t }));
    await a.next();
    const d = openWs(base);
    await d.opened;
    for (const s of [a, b, d]) s.ws.close();
  });

  it('closes sockets with 1001 when the server shuts down', async () => {
    const { base, token: t, server: s } = await boot();
    const ws = openWs(base);
    await ws.opened;
    ws.ws.send(JSON.stringify({ type: 'auth', token: t }));
    await ws.next();
    await s.close();
    server = undefined;
    expect((await ws.closed).code).toBe(WS_CLOSE.goingAway);
  });

  it('counts failures behind a trusted proxy against the forwarded client', async () => {
    const { base } = await boot({ trustedProxies: ['127.0.0.1'] });
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/doctor`, { headers: { ...auth('bad'), 'X-Forwarded-For': '203.0.113.7' } })).status).toBe(401);
    }
    expect((await fetch(`${base}/doctor`, { headers: { ...auth('bad'), 'X-Forwarded-For': '203.0.113.7' } })).status).toBe(429);
    expect((await fetch(`${base}/doctor`, { headers: { ...auth('bad'), 'X-Forwarded-For': '203.0.113.8' } })).status).toBe(401);
  });
});
