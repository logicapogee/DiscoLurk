import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { Clock } from '@disco-lurk/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { bearer, clientAddress, TOKEN_REQUIREMENT, TokenGuard, tokenStrongEnough } from './auth';
import { HEARTBEAT_MS, type ServerFrame } from './contract';
import { EventHub, HttpError } from './hub';



/** The shell's webview origin (Windows serves it over http://tauri.localhost). */
export const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;
export const WS_AUTH_TIMEOUT_MS = 5000;
/** Client frames are only the auth frame; anything near this size is not one. */
export const WS_MAX_PAYLOAD = 64 * 1024;
/** Sockets still waiting for their auth frame; more are refused until some authenticate or time out. */
export const WS_MAX_UNAUTHENTICATED = 16;
/** Failures that are not counted toward lockout (see `TokenGuard.exempt`) cost a fixed pause instead. */
export const LOOPBACK_FAILURE_DELAY_MS = 250;
const MAX_BODY_BYTES = 1024 * 1024;
/** How long clients get to acknowledge the going-away close before their sockets are cut. */
const CLOSE_GRACE_MS = 500;

/** `goingAway` (1001) tells the UI the server shut down on purpose, so it stops reconnecting. */
export const WS_CLOSE = { goingAway: 1001, authFailed: 4401, authTimeout: 4408, tokenRotated: 4001 } as const;

export interface Reply {
  status: number;
  body?: unknown;
  /** Sent as-is instead of JSON, with `contentType`. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Runs once the response has been written, for actions that would cut the response short. */
  after?: () => void | Promise<void>;
}

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Segments starting with `:` capture one URL-decoded path segment. */
  path: string;
  /** False only for `/health`; everything else needs the bearer token. */
  auth?: boolean;
  handle(ctx: RouteContext): Promise<Reply>;
}

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  version: string;
  clock: Clock;
  routes: Route[];
  hub?: EventHub;
  /** The built UI, served to remote browsers; the desktop shell bundles its own copy. */
  staticDir?: string;
  allowedOrigins?: readonly string[];
  /** Reverse proxies whose `X-Forwarded-For` names the client failures are counted against. */
  trustedProxies?: readonly string[];
  wsAuthTimeoutMs?: number;
  wsMaxUnauthenticated?: number;
  loopbackFailureDelayMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

export interface LurkServer {
  readonly port: number;
  rotateToken(token: string): void;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** The remote UI talks only to the origin that served it. */
const STATIC_CSP = "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

function send(res: ServerResponse, reply: Reply): void {
  res.statusCode = reply.status;
  for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
  if (reply.text !== undefined) {
    res.setHeader('Content-Type', reply.contentType ?? 'text/plain; charset=utf-8');
    return void res.end(reply.text);
  }
  if (reply.body === undefined) return void res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(reply.body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(':')) {
      if (!g) return null;
      try {
        params[w.slice(1)] = decodeURIComponent(g);
      } catch {
        return null;
      }
    } else if (w !== g) return null;
  }
  return params;
}

async function serveStatic(dir: string, pathname: string, res: ServerResponse): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(400, 'invalid-path');
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const file = join(dir, rel);
  if (!file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Content-Security-Policy', STATIC_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(await readFile(file));
  return true;
}

export async function startServer(opts: ServerOptions): Promise<LurkServer> {
  if (!tokenStrongEnough(opts.token)) throw new Error(`Token must be ${TOKEN_REQUIREMENT}`);
  const log = opts.log ?? (() => {});
  const allowed = new Set(opts.allowedOrigins ?? TAURI_ORIGINS);
  const guard = new TokenGuard(opts.token, opts.clock, (ip) => log(`auth: ${ip} locked out after repeated failures`));
  const authed = new Set<WebSocket>();
  const failureDelayMs = opts.loopbackFailureDelayMs ?? LOOPBACK_FAILURE_DELAY_MS;
  const trustedProxies = opts.trustedProxies ?? [];
  const sourceOf = (req: IncomingMessage) => clientAddress(req.socket.remoteAddress ?? 'unknown', req.headers['x-forwarded-for'], trustedProxies);
  const afterFailure = (ip: string, respond: () => void) => {
    if (guard.exempt(ip)) setTimeout(respond, failureDelayMs);
    else respond();
  };

  const routes: Route[] = [
    { method: 'GET', path: '/health', auth: false, handle: async () => ({ status: 200, body: { status: 'ok', version: opts.version } }) },
    ...opts.routes,
  ];

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, { status: 204 });
    let pathMatched = false;
    for (const route of routes) {
      const params = match(route.path, url.pathname);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const ip = sourceOf(req);
      if (route.auth !== false) {
        const verdict = guard.check(ip, bearer(req.headers.authorization));
        if (verdict === 'locked') return send(res, { status: 429, body: { error: 'locked' } });
        if (verdict === 'denied') return afterFailure(ip, () => send(res, { status: 401, body: { error: 'unauthorized' } }));
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
      const reply = await route.handle({ params, query: url.searchParams, body, ip });
      send(res, reply);
      if (reply.after) await reply.after();
      return;
    }
    if (pathMatched) return send(res, { status: 405, body: { error: 'method-not-allowed' } });
    if (req.method === 'GET' && opts.staticDir && (await serveStatic(opts.staticDir, url.pathname, res))) return;
    send(res, { status: 404, body: { error: 'not-found' } });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, { status: err.status, body: { error: err.code, message: err.message } });
        return;
      }
      log(`${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      // The details stay in the log: an exception message can carry paths and other host internals.
      if (!res.headersSent) send(res, { status: 500, body: { error: 'internal' } });
    });
  });

  const pending = new Set<WebSocket>();
  const maxPending = opts.wsMaxUnauthenticated ?? WS_MAX_UNAUTHENTICATED;
  const wss = new WebSocketServer({
    server: http,
    path: '/events',
    maxPayload: WS_MAX_PAYLOAD,
    // A browser always sends Origin: only the shell, the served UI (same origin) and listed origins
    // may open the socket. Non-browser clients send none and still have to pass the auth frame.
    verifyClient: ({ origin, req }: { origin: string | undefined; req: IncomingMessage }) => {
      if (pending.size >= maxPending) return false;
      if (!origin || allowed.has(origin)) return true;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });
  wss.on('connection', (ws, req) => {
    const ip = sourceOf(req);
    pending.add(ws);
    // Malformed or oversized frames surface here; the library closes the socket itself.
    ws.on('error', (err) => log(`ws ${ip}: ${err.message}`));
    const timer = setTimeout(() => ws.close(WS_CLOSE.authTimeout, 'auth-timeout'), opts.wsAuthTimeoutMs ?? WS_AUTH_TIMEOUT_MS);
    ws.once('message', (data) => {
      clearTimeout(timer);
      pending.delete(ws);
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        frame = null;
      }
      const token =
        typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'auth'
          ? (frame as { token?: unknown }).token
          : undefined;
      if (guard.check(ip, typeof token === 'string' ? token : undefined) !== 'ok') {
        afterFailure(ip, () => ws.close(WS_CLOSE.authFailed, 'auth-failed'));
        return;
      }
      authed.add(ws);
      ws.send(JSON.stringify({ type: 'auth-ok' } satisfies ServerFrame));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      pending.delete(ws);
      authed.delete(ws);
    });
  });

  const push = (frame: ServerFrame, data = JSON.stringify(frame)) => {
    for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const unsubscribe = opts.hub?.subscribe(push);
  const heartbeat = setInterval(() => push({ type: 'heartbeat', at: new Date(opts.clock.now()).toISOString() }), opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  return {
    port: (http.address() as AddressInfo).port,
    rotateToken(token) {
      if (!tokenStrongEnough(token)) throw new Error(`Token must be ${TOKEN_REQUIREMENT}`);
      guard.rotate(token);
      for (const ws of authed) ws.close(WS_CLOSE.tokenRotated, 'token-rotated');
      authed.clear();
    },
    async close() {
      clearInterval(heartbeat);
      unsubscribe?.();
      const sockets = [...wss.clients];
      await Promise.race([
        Promise.all(
          sockets.map(
            (ws) =>
              new Promise<void>((resolve) => {
                ws.once('close', () => resolve());
                ws.close(WS_CLOSE.goingAway, 'server-shutdown');
              }),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
      ]);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
