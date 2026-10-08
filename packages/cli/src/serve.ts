import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isLoopback, MIN_TOKEN_BYTES, TAURI_ORIGINS, tokenStrongEnough } from '@disco-lurk/server';
import { SidecarLifecycle } from './lifecycle';
import { appDataDir } from './paths';
import { credentialsFromEnv, UsageError } from './run';
import { bootServer } from './sidecar';

export interface ServeArgs {
  host: string;
  port: number;
  headless: boolean;
  origins: string[];
  uiDir: string | undefined;
  dataDir: string;
}

const isLoopbackHost = (host: string) => host === 'localhost' || isLoopback(host);

/** The built UI ships inside the binary next to the bundle; `--ui` or `LURK_UI_DIR` point elsewhere. */
function defaultUiDir(): string | undefined {
  const bundled = join(__dirname, 'ui');
  return existsSync(join(bundled, 'index.html')) ? bundled : undefined;
}

export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '8080' },
        headless: { type: 'boolean', default: false },
        origin: { type: 'string', multiple: true },
        ui: { type: 'string' },
        data: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid --port ${values.port}`);
  const ui = values.ui ?? env.LURK_UI_DIR;
  const data = values.data ?? env.LURK_DATA_DIR;
  return {
    host: values.host,
    port,
    headless: values.headless,
    origins: values.origin ?? [],
    uiDir: ui ? resolve(ui) : defaultUiDir(),
    dataDir: data ? resolve(data) : appDataDir(),
  };
}

/**
 * The token for `serve`: `LURK_TOKEN` when set. Without it only a loopback listener may start, and
 * it mints a token of its own and prints it once, since there is no shell to hand it to.
 */
export function serveToken(host: string, env: NodeJS.ProcessEnv): { token: string; minted: boolean } {
  const given = env.LURK_TOKEN;
  if (given !== undefined) {
    if (!tokenStrongEnough(given)) throw new UsageError(`LURK_TOKEN must be at least ${MIN_TOKEN_BYTES} bytes of random data`);
    return { token: given, minted: false };
  }
  if (!isLoopbackHost(host)) throw new UsageError(`Listening on ${host} requires LURK_TOKEN (at least ${MIN_TOKEN_BYTES} random bytes)`);
  return { token: randomBytes(32).toString('base64url'), minted: true };
}

export async function serve(argv: string[], version: string): Promise<number> {
  const args = parseServeArgs(argv);
  const { token, minted } = serveToken(args.host, process.env);
  const log = (m: string) => console.error(m);
  const lifecycle = new SidecarLifecycle(log);
  const server = await bootServer({
    version,
    host: args.host,
    port: args.port,
    token,
    dataDir: args.dataDir,
    headlessOnly: args.headless,
    lifecycle,
    // The served UI is same-origin; extra origins are for a UI hosted elsewhere, such as behind a proxy.
    allowedOrigins: [...TAURI_ORIGINS, ...args.origins],
    credentials: (site) => credentialsFromEnv(site),
    log,
    ...(args.uiDir ? { staticDir: args.uiDir } : {}),
  });
  const shown = args.host.includes(':') ? `[${args.host}]` : args.host;
  console.log(`lurk serve ${version} listening on http://${shown}:${server.port}${args.headless ? ' (headless)' : ''}`);
  console.log(args.uiDir ? `UI: ${args.uiDir}` : 'UI: not bundled; API only (pass --ui <dir>)');
  console.log(`Data: ${args.dataDir}`);
  if (minted) console.log(`Token (this run only; set LURK_TOKEN to keep one): ${token}`);
  process.once('SIGTERM', () => void lifecycle.shutdown('SIGTERM'));
  process.once('SIGINT', () => void lifecycle.shutdown('SIGINT'));
  await lifecycle.done;
  return 0;
}
