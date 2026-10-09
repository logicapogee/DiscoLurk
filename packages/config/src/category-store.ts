import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Category, CategoryStore, SiteId } from '@disco-lurk/core';
import { z } from 'zod';
import { writeJsonAtomic } from './json-file';
import { categorySchema } from './site';

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  siteId: z.string(),
  categories: z.array(categorySchema),
});

/** A discovered site's category list, one file per site under `<appData>/disco-lurk/sites/<siteId>/`. */
export class FileCategoryStore implements CategoryStore {
  /** The last write queued per site; writes to one site's file run one after another, in call order. */
  private readonly writes = new Map<SiteId, Promise<void>>();

  constructor(private readonly sitesDir: string) {}

  path(siteId: SiteId): string {
    return join(this.sitesDir, siteId, 'categories.json');
  }

  async load(siteId: SiteId): Promise<Category[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(siteId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${this.path(siteId)} is not valid JSON (${(err as Error).message}); fix or delete it`);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success || parsed.data.siteId !== siteId) throw new Error(`${this.path(siteId)} is not a valid category file for ${siteId}`);
    return parsed.data.categories;
  }

  save(siteId: SiteId, categories: Category[]): Promise<void> {
    const value = { schemaVersion: 1, siteId, categories: structuredClone(categories) };
    const previous = this.writes.get(siteId) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(() => writeJsonAtomic(this.path(siteId), value));
    this.writes.set(siteId, write);
    return write;
  }
}
