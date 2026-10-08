import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('serialises concurrent saves of one site in call order and leaves no temp file behind', async () => {
    const store = new FileCategoryStore(dir);
    const lists = Array.from({ length: 8 }, (_, i) => [{ name: `c${i}`, path: `/c/c${i}/${i + 1}`, id: i + 1, enabledByDefault: false }]);
    await Promise.all(lists.map((l) => store.save('docofcard', l)));
    expect(await store.load('docofcard')).toEqual(lists.at(-1));
    expect(await readdir(join(dir, 'docofcard'))).toEqual(['categories.json']);
  });

  it('two stores writing the same file use distinct temp files', async () => {
    const a = new FileCategoryStore(dir);
    const b = new FileCategoryStore(dir);
    const list = [{ name: 'General', path: '/c/general/4', id: 4, enabledByDefault: true }];
    await Promise.all([a.save('docofcard', list), b.save('docofcard', list), a.save('docofcard', list), b.save('docofcard', list)]);
    expect(await a.load('docofcard')).toEqual(list);
  });

  it('a corrupt file is an error naming the file, and it is left as it was', async () => {
    const store = new FileCategoryStore(dir);
    await store.save('docofcard', []);
    await writeFile(store.path('docofcard'), '{"schemaVersion": 1, "siteId": "docofc');
    await expect(store.load('docofcard')).rejects.toThrow(store.path('docofcard'));
    expect(await readFile(store.path('docofcard'), 'utf8')).toBe('{"schemaVersion": 1, "siteId": "docofc');
  });
});
