import { loadBuiltinSites } from '@disco-lurk/config';
import type { Site } from '@disco-lurk/core';
import categoriesFile from '../../../data/categories.json';
import sitesFile from '../../../data/sites.json';

/** Bundled into the binary, so built-in sites need no data directory at runtime. */
const DATA: Record<string, unknown> = { 'categories.json': categoriesFile };

export const BUILTIN_SITES: Site[] = loadBuiltinSites(sitesFile as Parameters<typeof loadBuiltinSites>[0], (name) => {
  if (!(name in DATA)) throw new Error(`Built-in data file ${name} is not bundled`);
  return DATA[name];
});

export function findSite(id: string): Site | undefined {
  return BUILTIN_SITES.find((s) => s.id === id);
}
