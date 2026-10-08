import type { RunStats } from './events';
import type { ProgressSource } from './terms';

/** §5.2 */
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
}

/** A parsed site progress page (§5.1 / §5.1b); `level` is numeric on linuxdo and a title on docofcard. */
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

export interface EstimatedMetric extends LevelMetric {
  estimated: number | null;
}

/** Without a baseline (S09, or `progressSource: 'none'`) there is nothing to add the local delta to. */
export function estimateMetrics(initial: LevelSnapshot | null, stats: RunStats): EstimatedMetric[] {
  if (!initial) return [];
  return initial.metrics.map((m) => {
    const delta = ESTIMATE[m.key];
    return { ...m, estimated: delta ? m.current + delta(stats) : null };
  });
}
