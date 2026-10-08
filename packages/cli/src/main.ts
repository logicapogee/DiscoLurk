import './inspector-shim';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { isAbortError, RunError, systemClock } from '@disco-lurk/core';
import { startServer } from '@disco-lurk/server';
import { formatDoctor, runDoctor } from './doctor';
import { profilesDir } from './paths';
import { SidecarLifecycle } from './lifecycle';
import { CAPTURE_STEPS, captureFixtures, expandSteps } from './capture';
import { browserSelftest } from './selftest';
import { BUILTIN_SITES, findSite } from './sites';

declare const __LURK_VERSION__: string | undefined;
const VERSION = typeof __LURK_VERSION__ === 'string' ? __LURK_VERSION__ : '0.0.0-dev';

/** §11.1 exit codes. */
const EXIT = { ok: 0, cancelled: 2, needsAuth: 3, environment: 4, contract: 5, noProgress: 6 } as const;

const USAGE = `lurk ${VERSION}

Usage:
  lurk doctor [--json] [--port <n>] [--network]
  lurk sidecar   (started by the desktop shell: prints a ready line, exits when stdin closes)
  lurk capture --site <id> [--profile <id>] [--channel chrome|msedge] [--out <dir>] [--steps <a,b>]   (development: Phase 0 fixtures; steps: ${CAPTURE_STEPS.join(',')})
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

/** Development command (Phase 0): the user logs in; fixtures land in tests/fixtures/<siteId>/. */
async function capture(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      profile: { type: 'string', default: 'default' },
      channel: { type: 'string', default: 'chrome' },
      out: { type: 'string' },
      steps: { type: 'string' },
    },
  });
  const site = values.site ? findSite(values.site) : undefined;
  if (!site) {
    console.error(`capture requires --site <${BUILTIN_SITES.map((s) => s.id).join('|')}>`);
    return EXIT.environment;
  }
  if (values.channel !== 'chrome' && values.channel !== 'msedge') {
    console.error('--channel must be chrome or msedge');
    return EXIT.environment;
  }
  if (!process.stdin.isTTY) {
    console.error('capture asks questions on the way; run it in an interactive terminal');
    return EXIT.environment;
  }
  let steps: Set<string> | undefined;
  try {
    steps = values.steps ? expandSteps(values.steps.split(',').map((s) => s.trim())) : undefined;
  } catch (err) {
    console.error((err as Error).message);
    return EXIT.environment;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const outDir = resolve(values.out ?? join('tests', 'fixtures', site.id));
  try {
    const report = await captureFixtures({
      site,
      profileDir: join(profilesDir(), site.id, values.profile),
      outDir,
      channel: values.channel,
      signal: controller.signal,
      ...(steps ? { steps } : {}),
      log: (m) => console.log(m),
      ask: (q) => rl.question(`\n>>> ${q}\n`),
    });
    const failed = Object.entries(report.steps).filter(([, r]) => !r.ok);
    console.log(`\nFixtures and capture.json written to ${outDir}`);
    if (failed.length) console.log(`Steps needing attention: ${failed.map(([n, r]) => `${n} (${r.note})`).join('; ')}`);
    return EXIT.ok;
  } catch (err) {
    if (isAbortError(err)) return EXIT.cancelled;
    if (err instanceof RunError) {
      console.error(`${err.code}: ${err.message}`);
      return err.code === 'needs-auth' ? EXIT.needsAuth : err.code === 'browser-missing' || err.code === 'profile-locked' ? EXIT.environment : EXIT.contract;
    }
    throw err;
  } finally {
    rl.close();
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
    case 'capture':
      return capture(rest);
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
