import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLedgerStore } from './ledger-store';

const day = 86_400_000;
const now = Date.UTC(2026, 9, 9);

describe('visit ledger file (§7.2)', () => {
  it('round-trips records per Profile and merges failures across visits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lurk-ledger-'));
    const store = new FileLedgerStore(dir, () => now);
    const ledger = await store.open('linuxdo/default');
    ledger.record({ topicId: '7', lastVisitAt: new Date(now).toISOString(), entered: false, failure: 'click-failed' });
    ledger.record({ topicId: '7', lastVisitAt: new Date(now).toISOString(), entered: true, floors: { from: 1, to: 9 }, verification: 'confirmed' });
    await ledger.save();
    expect(store.path('linuxdo/default')).toBe(join(dir, 'linuxdo', 'default.json'));
    const again = await store.open('linuxdo/default');
    expect(again.get('7')).toEqual({ topicId: '7', lastVisitAt: new Date(now).toISOString(), entered: true, floors: { from: 1, to: 9 }, verification: 'confirmed', failures: 1 });
  });

  it('drops records older than the retention period', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lurk-ledger-'));
    const store = new FileLedgerStore(dir, () => now, 30);
    const ledger = await store.open('docofcard/main');
    ledger.record({ topicId: 'old', lastVisitAt: new Date(now - 31 * day).toISOString(), entered: true });
    ledger.record({ topicId: 'new', lastVisitAt: new Date(now - 29 * day).toISOString(), entered: true });
    await ledger.save();
    const saved = JSON.parse(await readFile(store.path('docofcard/main'), 'utf8')) as { records: Array<{ topicId: string }> };
    expect(saved.records.map((r) => r.topicId)).toEqual(['new']);
  });

  it('names the file when it is not a ledger of this Profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lurk-ledger-'));
    const store = new FileLedgerStore(dir, () => now);
    await (await store.open('linuxdo/default')).save();
    await writeFile(store.path('linuxdo/default'), JSON.stringify({ schemaVersion: 1, profileId: 'linuxdo/other', records: [] }));
    await expect(store.open('linuxdo/default')).rejects.toThrow(/default\.json is not a valid visit ledger/);
  });
});
