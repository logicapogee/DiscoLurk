import type { ReadVerification } from './ports';
import { randomInt, type RandomSource } from './runtime';
import type { ProfileId, TopicCandidate } from './terms';

/** What the app remembers about one topic across runs of a Profile. */
export interface VisitRecord {
  topicId: string;
  lastVisitAt: string;
  entered: boolean;
  floors?: { from: number; to: number };
  verification?: ReadVerification;
  /** The last failure's reason, when the last visit failed. */
  failure?: string;
  /** Failed visits so far, kept while the record is within the retention period. */
  failures: number;
}

export type VisitOutcome = Omit<VisitRecord, 'failures'>;

/**
 * The visit ledger of one Profile. It is always written, so a skipped topic can be explained;
 * only the `smartRanked` experiment reads it to order candidates.
 */
export interface VisitLedger {
  get(topicId: string): VisitRecord | undefined;
  record(outcome: VisitOutcome): void;
  save(): Promise<void>;
}

export interface LedgerStore {
  open(profileId: ProfileId): Promise<VisitLedger>;
}

/** Merges a visit into the topic's previous record. */
export function mergeVisit(previous: VisitRecord | undefined, outcome: VisitOutcome): VisitRecord {
  const failed = outcome.failure !== undefined;
  return { ...outcome, failures: (previous?.failures ?? 0) + (failed ? 1 : 0) };
}

export class MemoryLedger implements VisitLedger {
  readonly records = new Map<string, VisitRecord>();
  saves = 0;

  get(topicId: string): VisitRecord | undefined {
    return this.records.get(topicId);
  }

  record(outcome: VisitOutcome): void {
    this.records.set(outcome.topicId, mergeVisit(this.records.get(outcome.topicId), outcome));
  }

  async save(): Promise<void> {
    this.saves++;
  }
}

const RECENT_MS = 7 * 24 * 3_600_000;

/**
 * Higher is better: never-visited topics first, then topics with more replies (more floors to
 * read); a topic visited in the last week or one that keeps failing sinks.
 */
export function topicScore(topic: TopicCandidate, record: VisitRecord | undefined, nowMs: number): number {
  let score = 0;
  if (topic.unread) score += 3;
  else if (topic.unreadPosts) score += 1;
  score += Math.min(2, Math.log10((topic.replies ?? 0) + 1));
  if (record && nowMs - Date.parse(record.lastVisitAt) < RECENT_MS) score -= 2;
  if (record) score -= Math.min(3, record.failures);
  return score;
}

/** The `smartRanked` draw: as many topics as a random draw would take, but the best scored ones. */
export function rankTopics(
  candidates: readonly TopicCandidate[],
  ledger: Pick<VisitLedger, 'get'>,
  nowMs: number,
  random: RandomSource,
  range: { min: number; max: number },
): TopicCandidate[] {
  const count = randomInt(random, range.min, range.max);
  // The small random term breaks ties without overriding any real difference in score.
  return candidates
    .map((t) => ({ t, score: topicScore(t, ledger.get(t.id), nowMs) + random.next() * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((x) => x.t);
}
