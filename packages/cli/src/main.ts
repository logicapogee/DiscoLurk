import './inspector-shim';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { systemClock } from '@disco-lurk/core';
import { startServer } from '@disco-lurk/server';
import { formatDoctor, runDoctor } from './doctor';
import { profilesDir } from './paths';
import { SidecarLifecycle } from './lifecycle';
import { browserSelftest } from './selftest';

declare const __LURK_VERSION__: string | undefined;
const VERSION = typeof __LURK_VERSION__ === 'string' ? __LURK_VERSION__ : '0.0.0-dev';

/** §11.1 exit codes. */
const EXIT = { ok: 0, cancelled: 2, needsAuth: 3, environment: 4, contract: 5, noProgress: 6 } as const;

const USAGE = `lurk ${VERSION}

Usage:
  lurk doctor [--json] [--port <n>] [--network]
  lurk sidecar   (started by the desktop shell: prints a ready line, exits when stdin closes)
  lurk --version`;

async function doctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, port: { type: 'string' }, network: { type: 'boolean' } },
  });
  const report = await runDoctor({
    version: VERSION,
    profilesDir: profilesDir(),
    ...(values.port ? { port: Number(values.port) } : {}),
    network: values.network ?? false,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.checks.some((c) => c.status === 'fail') ? EXIT.environment : EXIT.ok;
}

async function sidecar(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error('sidecar takes no arguments');
    return EXIT.environment;
  }
  // §10.3: the token never appears in argv, the environment or a file, where other local processes
  // could read it; only the shell, holding the other end of stdout, learns it from the ready line.
  const token = randomBytes(32).toString('base64url');
  // Once the shell is gone its ends of stdout/stderr are closed; dropping those write errors keeps
  // them from crashing the sidecar before cleanup finishes.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const lifecycle = new SidecarLifecycle((m) => console.error(m));
  // The shell spawns the sidecar on loopback only; remote access is the separate `serve` command (§10.3).
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token,
    version: VERSION,
    clock: systemClock,
    log: (m) => console.error(m),
    handlers: {
      doctor: () => runDoctor({ version: VERSION, profilesDir: profilesDir(), listeningPort: server.port }),
      shutdown: () => lifecycle.shutdown('/shutdown request'),
    },
  });
  console.log(JSON.stringify({ event: 'ready', port: server.port, token }));
  lifecycle.watchParent(process.stdin);
  process.once('SIGTERM', () => void lifecycle.shutdown('SIGTERM'));
  process.once('SIGINT', () => void lifecycle.shutdown('SIGINT'));
  await lifecycle.done;
  await server.close();
  return EXIT.ok;
}

/** Packaging-gate entry used by scripts/gate-sidecar.ts (§12.1); not a user-facing command. */
async function selftest(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'profile-dir': { type: 'string' },
      screenshot: { type: 'string' },
      channel: { type: 'string', default: 'chrome' },
      headed: { type: 'boolean', default: false },
    },
  });
  if (!values.url || !values['profile-dir'] || !values.screenshot) {
    console.error('selftest requires --url, --profile-dir and --screenshot');
    return EXIT.environment;
  }
  if (values.channel !== 'chrome' && values.channel !== 'msedge') {
    console.error('--channel must be chrome or msedge');
    return EXIT.environment;
  }
  try {
    const result = await browserSelftest({
      url: values.url,
      profileDir: values['profile-dir'],
      screenshot: values.screenshot,
      channel: values.channel,
      headed: values.headed,
    });
    console.log(JSON.stringify(result));
    return EXIT.ok;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: (err as Error).stack ?? String(err) }));
    return EXIT.environment;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'doctor':
      return doctor(rest);
    case 'sidecar':
      return sidecar(rest);
    case 'selftest':
      return selftest(rest);
    case '--version':
    case '-v':
      console.log(VERSION);
      return EXIT.ok;
    default:
      console.error(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? EXIT.ok : EXIT.environment;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(EXIT.environment);
  },
);
