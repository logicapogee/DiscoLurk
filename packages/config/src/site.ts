import type { Category, Site } from '@disco-lurk/core';
import { z } from 'zod';

export const categorySchema = z.object({
  name: z.string().min(1),
  path: z.string().regex(/^\/c\/[^\s]+\/\d+$/),
  id: z.number().int().positive(),
  enabledByDefault: z.boolean(),
});

/** Refinements tie each source field to the data it needs. */
export const siteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().min(1),
    baseUrl: z.url({ protocol: /^https?$/ }),
    kind: z.literal('discourse'),
    login: z.enum(['headed', 'password']),
    categorySource: z.enum(['builtin', 'discovered']),
    builtinCategories: z.array(categorySchema).optional(),
    progressSource: z.enum(['connect-linuxdo', 'trust-level-docofcard', 'none']),
    progressUrl: z.url({ protocol: /^https?$/ }).optional(),
    behaviorVerified: z.object({ clickEntryRequired: z.union([z.boolean(), z.literal('unverified')]) }),
  })
  .strict()
  .superRefine((site, ctx) => {
    if (site.categorySource === 'builtin' && !site.builtinCategories?.length) {
      ctx.addIssue({ code: 'custom', path: ['builtinCategories'], message: 'builtin sites need a category table' });
    }
    if (site.categorySource === 'discovered' && site.builtinCategories) {
      ctx.addIssue({ code: 'custom', path: ['builtinCategories'], message: 'discovered sites read categories after login' });
    }
    if (site.progressSource !== 'none' && !site.progressUrl) {
      ctx.addIssue({ code: 'custom', path: ['progressUrl'], message: 'a progress source needs its page URL' });
    }
  });

type SiteValidation = { ok: true; site: Site } | { ok: false; issues: string[] };

export function validateSite(input: unknown): SiteValidation {
  const parsed = siteSchema.safeParse(input);
  if (parsed.success) return { ok: true, site: parsed.data as Site };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`) };
}

interface SitesFile {
  schemaVersion: 1;
  sites: Array<Record<string, unknown> & { builtinCategories?: string }>;
}

interface CategoriesFile {
  schemaVersion: 1;
  siteId: string;
  categories: Category[];
}

/**
 * `data/sites.json` names its category table by file (`categories.json` stays separate);
 * `readData` resolves those names so this stays free of filesystem and bundling concerns.
 */
export function loadBuiltinSites(sitesFile: SitesFile, readData: (name: string) => unknown): Site[] {
  if (sitesFile.schemaVersion !== 1) throw new Error(`Unsupported sites.json schemaVersion ${String(sitesFile.schemaVersion)}`);
  return sitesFile.sites.map((raw) => {
    const resolved: Record<string, unknown> = { ...raw };
    if (typeof raw.builtinCategories === 'string') {
      const table = readData(raw.builtinCategories) as CategoriesFile;
      if (table.siteId !== raw.id) throw new Error(`${raw.builtinCategories} belongs to ${table.siteId}, not ${String(raw.id)}`);
      resolved.builtinCategories = table.categories;
    }
    const result = validateSite(resolved);
    if (!result.ok) throw new Error(`Invalid built-in site ${String(raw.id)}: ${result.issues.join('; ')}`);
    return result.site;
  });
}
