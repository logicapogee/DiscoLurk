import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCategoryStore } from './category-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lurk-categories-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CAT-001 persistence of discovered categories', () => {
  it('starts empty, round-trips through an atomic write and rejects another site\'s file', async () => {
    const store = new FileCategoryStore(dir);
    expect(await store.load('docofcard')).toEqual([]);
    const list = [{ name: '卡片交流', path: '/c/bank/6', id: 6, enabledByDefault: false }];
    await store.save('docofcard', list);
    expect(await store.load('docofcard')).toEqual(list);
    expect(JSON.parse(await readFile(store.path('docofcard'), 'utf8'))).toMatchObject({ schemaVersion: 1, siteId: 'docofcard' });
    await writeFile(store.path('docofcard'), JSON.stringify({ schemaVersion: 1, siteId: 'linuxdo', categories: list }));
    await expect(store.load('docofcard')).rejects.toThrow(/not a valid category file/);
  });
});
