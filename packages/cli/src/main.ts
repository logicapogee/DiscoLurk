import './inspector-shim';
import { parseArgs } from 'node:util';
import { systemClock } from '@disco-lurk/core';
import { startServer } from '@disco-lurk/server';
import { formatDoctor, runDoctor } from './doctor';
import { profilesDir } from './paths';
import { browserSelftest } from './selftest';

declare const __LURK_VERSION__: string | undefined;
const VERSION = typeof __LURK_VERSION__ === 'string' ? __LURK_VERSION__ : '0.0.0-dev';

/** §11.1 exit codes. */
const EXIT = { ok: 0, cancelled: 2, needsAuth: 3, environment: 4, contract: 5, noProgress: 6 } as const;

const USAGE = `lurk ${VERSION}

Usage:
  lurk doctor [--json] [--port <n>] [--network]
  lurk sidecar --port <n> --token <token>
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
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, token: { type: 'string' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !values.token) {
    console.error('sidecar requires --port <1-65535> and --token <token>');
    return EXIT.environment;
  }
  let release: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (release = resolve));
  // The shell spawns the sidecar on loopback only; remote access is the separate `serve` command (§10.3).
  const server = await startServer({
    host: '127.0.0.1',
    port,
    token: values.token,
    version: VERSION,
    clock: systemClock,
    log: (m) => console.error(m),
    handlers: {
      doctor: () => runDoctor({ version: VERSION, profilesDir: profilesDir(), listeningPort: port }),
      shutdown: async () => release(),
    },
  });
  console.log(JSON.stringify({ type: 'ready', port: server.port, version: VERSION }));
  const onSignal = () => release();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  await stopped;
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
