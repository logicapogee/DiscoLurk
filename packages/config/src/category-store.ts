import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Category, CategoryStore, SiteId } from '@disco-lurk/core';
import { z } from 'zod';
import { categorySchema } from './site';

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  siteId: z.string(),
  categories: z.array(categorySchema),
});

/** §11.1: temp file + rename, so a crash mid-write leaves the previous file intact. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

/** A discovered site's category list, one file per site under `<appData>/disco-lurk/sites/<siteId>/`. */
export class FileCategoryStore implements CategoryStore {
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
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.siteId !== siteId) throw new Error(`${this.path(siteId)} is not a valid category file for ${siteId}`);
    return parsed.data.categories;
  }

  async save(siteId: SiteId, categories: Category[]): Promise<void> {
    await writeJsonAtomic(this.path(siteId), { schemaVersion: 1, siteId, categories });
  }
}
