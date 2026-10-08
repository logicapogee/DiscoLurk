import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock, RunEvent } from '@disco-lurk/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { bearer, isLoopback, MIN_TOKEN_BYTES, TokenGuard, tokenStrongEnough } from './auth';

/** The shell's webview origin (Windows serves it over http://tauri.localhost). */
export const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;
export const WS_AUTH_TIMEOUT_MS = 5000;
/** Loopback failures are not counted toward lockout, so each one costs a fixed pause instead. */
export const LOOPBACK_FAILURE_DELAY_MS = 250;

export const WS_CLOSE = { authFailed: 4401, authTimeout: 4408, tokenRotated: 4001 } as const;

export interface ServerHandlers {
  doctor(): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  version: string;
  clock: Clock;
  handlers: ServerHandlers;
  allowedOrigins?: readonly string[];
  wsAuthTimeoutMs?: number;
  loopbackFailureDelayMs?: number;
  log?: (message: string) => void;
}

export interface LurkServer {
  readonly port: number;
  rotateToken(token: string): void;
  broadcast(event: RunEvent): void;
  close(): Promise<void>;
}

type Route = { method: 'GET' | 'POST'; auth: boolean; handle: (res: ServerResponse) => Promise<void> };

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body === undefined) return void res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export async function startServer(opts: ServerOptions): Promise<LurkServer> {
  if (!tokenStrongEnough(opts.token)) throw new Error(`Token must be at least ${MIN_TOKEN_BYTES} bytes`);
  const log = opts.log ?? (() => {});
  const allowed = new Set(opts.allowedOrigins ?? TAURI_ORIGINS);
  const guard = new TokenGuard(opts.token, opts.clock, (ip) => log(`auth: ${ip} locked out after repeated failures`));
  const authed = new Set<WebSocket>();
  const failureDelayMs = opts.loopbackFailureDelayMs ?? LOOPBACK_FAILURE_DELAY_MS;
  const afterFailure = (ip: string, respond: () => void) => {
    if (isLoopback(ip)) setTimeout(respond, failureDelayMs);
    else respond();
  };

  const routes: Record<string, Route> = {
    '/health': {
      method: 'GET',
      auth: false,
      handle: async (res) => send(res, 200, { status: 'ok', version: opts.version }),
    },
    '/doctor': {
      method: 'GET',
      auth: true,
      handle: async (res) => send(res, 200, await opts.handlers.doctor()),
    },
    '/shutdown': {
      method: 'POST',
      auth: true,
      handle: async (res) => {
        send(res, 202, { status: 'shutting-down' });
        await opts.handlers.shutdown();
      },
    },
  };

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  };

  const http = createServer((req, res) => {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes[url.pathname];
    if (req.method === 'OPTIONS') return send(res, 204);
    if (!route) return send(res, 404, { error: 'not-found' });
    if (req.method !== route.method) return send(res, 405, { error: 'method-not-allowed' });
    if (route.auth) {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const verdict = guard.check(ip, bearer(req.headers.authorization));
      if (verdict === 'locked') return send(res, 429, { error: 'locked' });
      if (verdict === 'denied') return afterFailure(ip, () => send(res, 401, { error: 'unauthorized' }));
    }
    route.handle(res).catch((err: unknown) => {
      log(`route ${url.pathname} failed: ${String(err)}`);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    });
  });

  const wss = new WebSocketServer({ server: http, path: '/events' });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const timer = setTimeout(() => ws.close(WS_CLOSE.authTimeout, 'auth-timeout'), opts.wsAuthTimeoutMs ?? WS_AUTH_TIMEOUT_MS);
    ws.once('message', (data) => {
      clearTimeout(timer);
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
      ws.send(JSON.stringify({ type: 'auth-ok' }));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      authed.delete(ws);
    });
  });

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
      if (!tokenStrongEnough(token)) throw new Error(`Token must be at least ${MIN_TOKEN_BYTES} bytes`);
      guard.rotate(token);
      for (const ws of authed) ws.close(WS_CLOSE.tokenRotated, 'token-rotated');
      authed.clear();
    },
    broadcast(event) {
      const frame = JSON.stringify({ type: 'event', event });
      for (const ws of authed) ws.send(frame);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
