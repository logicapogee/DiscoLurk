import { join } from 'node:path';
import { FileCategoryStore } from '@disco-lurk/config';
import { DiscoLurkCoordinator, systemClock, systemSleeper } from '@disco-lurk/core';
import { EventHub, HISTORY_LIMIT, PresetStore, ProfileGate, RunHistory, RunManager, ScheduleService, SiteCatalog } from '@disco-lurk/server';
import { proxyFromEnv } from './env';
import { sitesDir } from './paths';
import { cliEnv, credentialsFromEnv, newSeed, siteCategories } from './run';
import { BUILTIN_SITES } from './sites';

/** The sites with their categories as stored under `dataDir`. */
async function catalogOnly(dataDir: string): Promise<{ catalog: SiteCatalog }> {
  const store = new FileCategoryStore(sitesDir(dataDir));
  const catalog = new SiteCatalog(BUILTIN_SITES, (site) => siteCategories(site, store));
  await catalog.refreshAll();
  return { catalog };
}

export interface CliServices {
  hub: EventHub;
  catalog: SiteCatalog;
  runs: RunManager;
  schedules: ScheduleService;
  /** Stops what still runs, waits for its records and gives up the schedule lock. */
  close(): Promise<void>;
}

/**
 * The server's run and schedule services for one CLI command, over the same data directory and
 * with nobody listening on the hub but the command itself. The schedules are adopted, not looped.
 */
async function open(dataDir: string, opts: { log(message: string): void }): Promise<CliServices> {
  const { catalog } = await catalogOnly(dataDir);
  const hub = new EventHub();
  const gate = new ProfileGate();
  const exit = new AbortController();
  const presets = new PresetStore(join(dataDir, 'presets.json'));
  const history = new RunHistory(join(dataDir, 'runs'), HISTORY_LIMIT, opts.log);
  await Promise.all([presets.load(), history.load()]);
  const proxy = proxyFromEnv(process.env);
  const coordinator = new DiscoLurkCoordinator(
    cliEnv({ channel: 'chrome', exitSignal: exit.signal, credentials: (site) => credentialsFromEnv(site), ...(proxy ? { proxy } : {}) }),
  );
  const runs = new RunManager({ coordinator, catalog, history, hub, gate, clock: systemClock, newSeed, notify: () => {}, log: opts.log });
  const schedules = new ScheduleService({
    clock: systemClock,
    sleeper: systemSleeper,
    dataDir,
    presets,
    catalog,
    runs,
    gate,
    hub,
    displayAvailable: () => true,
    log: opts.log,
  });
  await schedules.start({ loop: false });
  return {
    hub,
    catalog,
    runs,
    schedules,
    async close() {
      runs.stopAll('app-exit');
      exit.abort();
      await runs.settle();
      await schedules.close();
    },
  };
}

export const cliServices = { open, catalogOnly };
