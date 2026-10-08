import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeVisit, type LedgerStore, type ProfileId, type VisitLedger, type VisitOutcome, type VisitRecord } from '@disco-lurk/core';
import { z } from 'zod';
import { writeJsonAtomic } from './category-store';

const recordSchema = z.object({
  topicId: z.string(),
  lastVisitAt: z.string(),
  entered: z.boolean(),
  floors: z.object({ from: z.number(), to: z.number() }).optional(),
  verification: z.enum(['confirmed', 'still-unread', 'indeterminate', 'not-applicable']).optional(),
  failure: z.string().optional(),
  failures: z.number().int().nonnegative(),
});

const fileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string(),
  records: z.array(recordSchema),
});

export const LEDGER_RETENTION_DAYS = 30;

/**
 * One visit ledger per Profile at `<ledgersDir>/<siteId>/<name>.json`. Records older than the
 * retention period are dropped on load and on save, so the file stays bounded.
 */
export class FileLedgerStore implements LedgerStore {
  constructor(
    private readonly ledgersDir: string,
    private readonly now: () => number = Date.now,
    private readonly retentionDays = LEDGER_RETENTION_DAYS,
  ) {}

  path(profileId: ProfileId): string {
    const [siteId, name] = profileId.split('/');
    if (!siteId || !name) throw new Error(`Invalid profile id ${profileId}`);
    return join(this.ledgersDir, siteId, `${name}.json`);
  }

  async open(profileId: ProfileId): Promise<VisitLedger> {
    const path = this.path(profileId);
    let records: VisitRecord[] = [];
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success || parsed.data.profileId !== profileId) throw new Error(`${path} is not a valid visit ledger for ${profileId}; fix or delete it`);
      records = parsed.data.records.map(({ floors, verification, failure, ...rest }) => ({
        ...rest,
        ...(floors ? { floors } : {}),
        ...(verification ? { verification } : {}),
        ...(failure !== undefined ? { failure } : {}),
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const cutoff = () => this.now() - this.retentionDays * 86_400_000;
    const map = new Map(records.filter((r) => Date.parse(r.lastVisitAt) >= cutoff()).map((r) => [r.topicId, r]));
    return {
      get: (topicId) => map.get(topicId),
      record: (outcome: VisitOutcome) => {
        map.set(outcome.topicId, mergeVisit(map.get(outcome.topicId), outcome));
      },
      save: () => {
        const kept = [...map.values()].filter((r) => Date.parse(r.lastVisitAt) >= cutoff());
        return writeJsonAtomic(path, { schemaVersion: 1, profileId, records: kept });
      },
    };
  }
}
