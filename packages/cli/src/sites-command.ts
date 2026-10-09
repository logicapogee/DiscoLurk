import { join } from 'node:path';
import { FileCategoryStore } from '@disco-lurk/config';
import { DiscoLurkCoordinator, type Site } from '@disco-lurk/core';
import { SiteStore } from '@disco-lurk/server';
import { proxyFromEnv } from './env';
import { appDataDir, sitesDir } from './paths';
import { cliEnv, credentialsFromEnv, EXIT, parseOrUsageError, profileIdOf, siteCategories, UsageError } from './run';
import { BUILTIN_SITES } from './sites';

export const SITES_USAGE = `  lurk sites list [--json]
  lurk sites discover-categories --site <id> [--profile <name>] [--channel chrome|msedge] [--json]`;

/** The built-in sites and the ones added in the UI. */
export async function allSites(dataDir = appDataDir()): Promise<Site[]> {
  const added = await new SiteStore(join(dataDir, 'custom-sites.json')).load();
  return [...BUILTIN_SITES, ...added.filter((s) => !BUILTIN_SITES.some((b) => b.id === s.id))];
}

export async function sites(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const store = new FileCategoryStore(sitesDir());
  switch (sub) {
    case 'list': {
      const { json } = parseOrUsageError(rest, { json: { type: 'boolean', default: false } });
      const list = await allSites();
      const rows = await Promise.all(list.map(async (site) => ({ site, categories: await siteCategories(site, store).catch(() => []) })));
      if (json) console.log(JSON.stringify(rows, null, 2));
      else
        for (const { site, categories } of rows) {
          console.log(`${site.id}  ${site.displayName}  ${site.baseUrl}  login ${site.login} · ${site.categorySource} categories (${categories.length}) · progress ${site.progressSource}`);
        }
      return EXIT.ok;
    }
    case 'discover-categories': {
      const v = parseOrUsageError(rest, {
        site: { type: 'string' },
        profile: { type: 'string', default: 'default' },
        channel: { type: 'string', default: 'chrome' },
        json: { type: 'boolean', default: false },
      });
      const known = await allSites();
      const site = known.find((s) => s.id === v.site);
      if (!site) throw new UsageError(`sites discover-categories needs --site <${known.map((s) => s.id).join('|')}>`);
      if (v.channel !== 'chrome' && v.channel !== 'msedge') throw new UsageError('--channel must be chrome or msedge');
      if (site.categorySource === 'builtin') {
        console.error(`${site.id} uses its built-in category table; nothing to discover`);
        console.log(v.json ? JSON.stringify(site.builtinCategories ?? [], null, 2) : (site.builtinCategories ?? []).map((c) => `${c.path}  ${c.name}`).join('\n'));
        return EXIT.ok;
      }
      const proxy = proxyFromEnv(process.env);
      const credentials = credentialsFromEnv(site);
      const coordinator = new DiscoLurkCoordinator(cliEnv({ channel: v.channel, sites: known, ...(credentials ? { credentials } : {}), ...(proxy ? { proxy } : {}) }));
      // A headless health check of a signed-in Profile is where a discovered site reads its categories.
      const health = await coordinator.inspect(profileIdOf(site.id, v.profile));
      if (health.status !== 'ready') {
        console.error(`Profile ${health.profileId} is ${health.status}; sign in with \`lurk login --site ${site.id} --profile ${v.profile}\` first`);
        return health.status === 'needs-auth' ? EXIT.needsAuth : EXIT.environment;
      }
      const categories = await store.load(site.id);
      console.log(v.json ? JSON.stringify(categories, null, 2) : categories.map((c) => `${c.path}  ${c.name}${c.enabledByDefault ? '' : '  (off by default)'}`).join('\n'));
      return EXIT.ok;
    }
    default:
      throw new UsageError(sub ? `Unknown sites command ${sub}` : 'sites needs a command');
  }
}
