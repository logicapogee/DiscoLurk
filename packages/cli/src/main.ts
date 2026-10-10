import './inspector-shim';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DiscoLurkCoordinator, isAbortError, RunError } from '@disco-lurk/core';
import { formatDoctor, runDoctor } from './doctor';
import { ConfigFileError, FileCategoryStore } from '@disco-lurk/config';
import { appDataDir, profilesDir, sitesDir } from './paths';
import { runSidecar } from './sidecar';
import { CAPTURE_STEPS, captureFixtures, expandSteps } from './capture';
import { browserSelftest } from './selftest';
import { installStopHandlers } from './signals';
import { EnvError, envWarnings, proxyFromEnv, runArgvWithEnv } from './env';
import { schedule, SCHEDULE_USAGE } from './schedule';
import { sites, SITES_USAGE } from './sites-command';
import { PresetStore, planFor } from '@disco-lurk/server';
import { serve } from './serve';
import { BUILTIN_SITES, findSite } from './sites';
import {
  buildPlan,
  cliEnv,
  createReporter,
  credentialsFromEnv,
  EXIT,
  exitCodeFor,
  interactionLine,
  newSeed,
  parseLoginArgs,
  parsePresetRunArgs,
  parseProfileId,
  parseRunArgs,
  presetArg,
  profileIdOf,
  resolveCategories,
  siteCategories,
  signIn,
  UsageError,
} from './run';

declare const __LURK_VERSION__: string | undefined;
const VERSION = typeof __LURK_VERSION__ === 'string' ? __LURK_VERSION__ : '0.0.0-dev';

const USAGE = `lurk ${VERSION}

Usage:
  lurk login --site <id> [--profile <name>] [--channel chrome|msedge]
  lurk run --site <id> [--profile <name>] [--browse-mode deep|quick [--quick-floors <n>[-<max>]]] [--run-mode endless|topics:<n>[-<max>]|time:<min≤1440>]
           [--categories <slug|path,...>] [--headed|--headless] [--channel chrome|msedge] [--json]
           [--like [--like-rate <%>] [--reply-like-rate <%>] [--max-reply-likes <n≤4>]]
           [--reply --i-understand-auto-reply-risk [--reply-rate <%>]]
           [--extra-wait <min>-<max>|off] [--experiments useNewList,useUnreadList,refreshCategories,smartRanked]
  lurk run --preset <id> [--profile <name>] [--headed|--headless] [--channel chrome|msedge] [--json]
${SCHEDULE_USAGE}
${SITES_USAGE}
  lurk doctor [--json] [--port <n>] [--network]
  lurk serve [--host 127.0.0.1] [--port 8080] [--headless] [--origin <url>]... [--trusted-proxy <ip>]... [--ui <dir>] [--data <dir>]
             (remote web UI; a non-loopback --host requires LURK_TOKEN)
  lurk sidecar   (started by the desktop shell: prints a ready line, exits when stdin closes)
  lurk capture --site <id> [--profile <id>] [--channel chrome|msedge] [--out <dir>] [--steps <a,b>]   (development: capture page fixtures; steps: ${CAPTURE_STEPS.join(',')})
  lurk --version`;

async function doctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, port: { type: 'string' }, network: { type: 'boolean' } },
  });
  const report = await runDoctor({
    version: VERSION,
    profilesDir: profilesDir(),
    sites: BUILTIN_SITES.map((site) => ({ site, categories: () => siteCategories(site, new FileCategoryStore(sitesDir())) })),
    ...(values.port ? { port: Number(values.port) } : {}),
    network: values.network ?? false,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.checks.some((c) => c.status === 'fail') ? EXIT.environment : EXIT.ok;
}

/** Packaging-gate entry used by scripts/gate-sidecar.ts; not a user-facing command. */
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

/** Development command: the user logs in; fixtures land in tests/fixtures/<siteId>/. */
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
  const { signal } = installStopHandlers();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const outDir = resolve(values.out ?? join('tests', 'fixtures', site.id));
  try {
    const report = await captureFixtures({
      site,
      profileDir: join(profilesDir(), site.id, values.profile),
      outDir,
      channel: values.channel,
      signal,
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

async function login(argv: string[]): Promise<number> {
  const args = parseLoginArgs(argv);
  const { signal, exitSignal } = installStopHandlers();
  const coordinator = new DiscoLurkCoordinator(cliEnv({ channel: args.channel, exitSignal }));
  const profileId = profileIdOf(args.site.id, args.profile);
  const auth = await coordinator.beginAuth(profileId);
  console.log(`Sign in to ${args.site.displayName} in the Chrome window (Profile ${profileId}).`);
  console.log('Checking for #current-user every 5 s for up to 300 s; the page is never reloaded.');
  const code = await signIn(auth, signal, console.log);
  if (code === EXIT.ok && args.site.categorySource === 'discovered') console.log('Categories are discovered on the first run; new ones start disabled.');
  return code;
}

async function run(argv: string[]): Promise<number> {
  const args = parseRunArgs(argv);
  for (const line of [...envWarnings(process.env), ...args.usageWarnings]) console.error(`warning: ${line}`);
  const { signal, exitSignal } = installStopHandlers(() => console.error('Stopping… (Ctrl+C again skips the final progress read)'));
  const credentials = credentialsFromEnv(args.site);
  const proxy = proxyFromEnv(process.env);
  const env = cliEnv({ channel: args.channel, exitSignal, ...(credentials ? { credentials } : {}), ...(proxy ? { proxy } : {}) });
  const categories = resolveCategories(args.site, await siteCategories(args.site, env.categories), args.categories);
  const plan = buildPlan(args, categories, newSeed(), new Date(), (code, message) => console.error(`warning ${code}: ${message}`));
  const coordinator = new DiscoLurkCoordinator(env);
  const reporter = createReporter(args.json, Date.now());
  // Profile, browser form and channel are stated before anything starts.
  reporter.plan(
    plan,
    `${args.site.displayName} · Profile ${plan.profileId} · ${plan.browserMode} ${args.channel} · ${plan.preset.browseMode} · ${JSON.stringify(plan.preset.runMode)} · ${categories.map((c) => c.path).join(', ') || 'no categories'}\n` +
      `likes ${interactionLine(plan.preset.interaction)} · extra wait ${plan.preset.extraWait.enabled ? `${plan.preset.extraWait.minSec}–${plan.preset.extraWait.maxSec} s` : 'off'}`,
  );
  const result = await coordinator.run(plan, signal, reporter.event);
  reporter.result(result);
  return exitCodeFor(result);
}

/** `lurk run --preset <id>`: a preset saved in the UI, run from the command line. */
async function runPreset(argv: string[]): Promise<number> {
  const args = parsePresetRunArgs(argv);
  for (const line of envWarnings(process.env)) console.error(`warning: ${line}`);
  const presets = new PresetStore(join(appDataDir(), 'presets.json'));
  await presets.load();
  const preset = presets.get(args.presetId);
  if (!preset) throw new UsageError(`No preset ${args.presetId}; presets are saved on the UI's run page (${presets.list().map((p) => p.id).join(', ') || 'none yet'})`);
  const site = findSite(preset.siteId);
  if (!site) throw new UsageError(`Preset ${preset.id} names unknown site ${preset.siteId}`);
  const profile = args.profile ?? (preset.profileId ? parseProfileId(preset.profileId).name : 'default');
  const { signal, exitSignal } = installStopHandlers(() => console.error('Stopping… (Ctrl+C again skips the final progress read)'));
  const credentials = credentialsFromEnv(site);
  const proxy = proxyFromEnv(process.env);
  const env = cliEnv({ channel: args.channel, exitSignal, sites: BUILTIN_SITES, ...(credentials ? { credentials } : {}), ...(proxy ? { proxy } : {}) });
  const categories = resolveCategories(site, await siteCategories(site, env.categories), preset.categoryPaths);
  const plan = planFor(
    { ...preset, profileId: profileIdOf(site.id, profile), browserMode: args.browserMode ?? preset.browserMode },
    categories,
    newSeed(),
    Date.now(),
    (code, message) => console.error(`warning ${code}: ${message}`),
  );
  const reporter = createReporter(args.json, Date.now());
  reporter.plan(plan, `${site.displayName} · preset ${preset.name} · Profile ${plan.profileId} · ${plan.browserMode} ${args.channel} · ${plan.preset.browseMode} · ${JSON.stringify(plan.preset.runMode)}`);
  const result = await new DiscoLurkCoordinator(env).run(plan, signal, reporter.event);
  reporter.result(result);
  return exitCodeFor(result);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'login':
      return login(rest);
    case 'run':
      // A preset carries its own site and options, so the LURK_* defaults for them stay out.
      return presetArg(rest) !== null ? runPreset(rest) : run(runArgvWithEnv(rest, process.env));
    case 'sites':
      return sites(rest);
    case 'schedule':
      return schedule(rest);
    case 'doctor':
      return doctor(rest);
    case 'sidecar':
      return runSidecar(rest, VERSION);
    case 'serve':
      return serve(rest, VERSION);
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
    if (err instanceof UsageError) console.error(`${err.message}\n\n${USAGE}`);
    else if (err instanceof EnvError || err instanceof ConfigFileError) console.error(err.message);
    else if (err instanceof RunError) console.error(`${err.code}: ${err.message}`);
    else console.error(err);
    process.exit(EXIT.environment);
  },
);
