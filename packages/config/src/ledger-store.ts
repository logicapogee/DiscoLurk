import { readFile } from 'node:fs/promises';
import { MapLedger, type LedgerStore, type ProfileId, type VisitLedger, type VisitRecord } from '@disco-lurk/core';
import { z } from 'zod';
import { writeJsonAtomic } from './json-file';

const recordSchema = z
  .object({
    topicId: z.string(),
    lastVisitAt: z.string(),
    entered: z.boolean(),
    floors: z.object({ from: z.number(), to: z.number() }).strict().optional(),
    verification: z.enum(['confirmed', 'still-unread', 'indeterminate', 'not-applicable']).optional(),
    failure: z.string().optional(),
    failures: z.number().int().nonnegative(),
  })
  .strict();

const fileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string(),
    records: z.array(recordSchema),
  })
  .strict();

const LEDGER_RETENTION_DAYS = 30;

/**
 * One visit ledger file per Profile, at the path `pathOf` gives it. Records older than the
 * retention period are dropped on load and on save, so the file stays bounded.
 */
export class FileLedgerStore implements LedgerStore {
  constructor(
    private readonly pathOf: (profileId: ProfileId) => string,
    private readonly now: () => number = Date.now,
    /** A number, or a getter for a setting the user can change while the app runs. */
    private readonly retentionDays: number | (() => number) = LEDGER_RETENTION_DAYS,
  ) {}

  path(profileId: ProfileId): string {
    return this.pathOf(profileId);
  }

  async open(profileId: ProfileId): Promise<VisitLedger> {
    const path = this.path(profileId);
    let records: VisitRecord[] = [];
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success || parsed.data.profileId !== profileId) throw new Error(`${path} is not a valid visit ledger for ${profileId}; fix or delete it`);
      // The strict schema admits exactly the fields of a VisitRecord.
      records = parsed.data.records as VisitRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new MapLedger(this.recent(records), (all) => writeJsonAtomic(path, { schemaVersion: 1, profileId, records: this.recent(all) }));
  }

  private recent(records: readonly VisitRecord[]): VisitRecord[] {
    const days = typeof this.retentionDays === 'number' ? this.retentionDays : this.retentionDays();
    const cutoff = this.now() - days * 86_400_000;
    return records.filter((r) => Date.parse(r.lastVisitAt) >= cutoff);
  }
}
