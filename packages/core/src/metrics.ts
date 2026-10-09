import type { RunStats } from './events';
import type { ProgressSource } from './terms';

/** The metrics a progress page label can map to; `other` gathers labels without a key. */
export type MetricKey =
  | 'topicsViewed'
  | 'postsRead'
  | 'readingTime'
  | 'likesGiven'
  | 'likesReceived'
  | 'repliesPosted'
  | 'flagged'
  | 'suspended'
  | 'silenced'
  | 'other';

export interface LevelMetric {
  label: string;
  key: MetricKey;
  current: number;
  required: number | null;
  /** The requirement is a ceiling to stay at or under (flags, bans) rather than a goal to reach. */
  limit?: true;
}

/** A parsed site progress page; `level` is numeric on linuxdo and a title on docofcard. */
export interface LevelSnapshot {
  source: Exclude<ProgressSource, 'none'>;
  username?: string;
  level?: number | string;
  nextLevel?: number | string;
  percent?: number;
  metrics: LevelMetric[];
}

/**
 * Only these keys have a local estimate. Keyword matching on labels mis-attributed counts
 * (reading time grew with topics, likes received grew with likes given), so every other key
 * waits for the site's reported value.
 */
export const ESTIMATE: Partial<Record<MetricKey, (s: RunStats) => number>> = {
  topicsViewed: (s) => s.confirmed.topics,
  postsRead: (s) => s.confirmed.floors,
  likesGiven: (s) => s.confirmed.likes + s.confirmed.replyLikes,
  repliesPosted: (s) => s.confirmed.repliedTopics,
};

interface EstimatedMetric extends LevelMetric {
  estimated: number | null;
}

/** Without a baseline (a failed initial read, or `progressSource: 'none'`) there is nothing to add the local delta to. */
export function estimateMetrics(initial: LevelSnapshot | null, stats: RunStats): EstimatedMetric[] {
  if (!initial) return [];
  return initial.metrics.map((m) => {
    const delta = ESTIMATE[m.key];
    return { ...m, estimated: delta ? m.current + delta(stats) : null };
  });
}
