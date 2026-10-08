import type { MetricKey } from './metrics';

/** §6.2 */
export type RunState =
  | 'queued'
  | 'launching'
  | 'awaiting_login'
  | 'needs_auth'
  | 'challenge_detected'
  | 'reading_initial_progress'
  | 'browsing'
  | 'stopping'
  | 'no_progress'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** §6.4 */
export const ERROR_CODES = [
  'browser-missing',
  'profile-locked',
  'needs-auth',
  'challenge-detected',
  'proxy-failed',
  'network-failed',
  'page-timeout',
  'selector-contract-broken',
  'no-candidates',
  'no-progress',
  'like-limit',
  'action-rejected',
  'cancelled',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RunFailure {
  code: ErrorCode;
  message: string;
}

export interface StatCounters {
  topics: number;
  floors: number;
  likes: number;
  replyLikes: number;
  replies: number;
}

export interface RunStats {
  attempted: StatCounters;
  confirmed: StatCounters;
  estimatedFloors: number;
  reported?: Partial<Record<MetricKey, { initial?: number; final: number }>>;
  /** Monotonic clock (S04). */
  elapsedMs: number;
}

export type RunEvent =
  | { type: 'state'; at: string; state: RunState }
  | { type: 'topic'; at: string; topicId: string; phase: 'click' | 'entered' | 'read' | 'returned'; result?: string }
  | { type: 'floor'; at: string; from: number; to: number; confirmed: boolean }
  | { type: 'action'; at: string; action: 'like' | 'reply'; result: 'attempted' | 'confirmed' | 'rejected' }
  | { type: 'timings'; at: string; postsReported: number; topicSeconds: number }
  | { type: 'stats'; at: string; stats: RunStats }
  | { type: 'warning'; at: string; code: string; message: string }
  | { type: 'error'; at: string; error: RunFailure };

export type RunOutcome = 'completed' | 'failed' | 'cancelled';

export interface RunResult {
  outcome: RunOutcome;
  stats: RunStats;
  failure?: RunFailure;
  baseline: 'present' | 'missing' | 'not-applicable';
}

export function emptyCounters(): StatCounters {
  return { topics: 0, floors: 0, likes: 0, replyLikes: 0, replies: 0 };
}

export function emptyStats(): RunStats {
  return { attempted: emptyCounters(), confirmed: emptyCounters(), estimatedFloors: 0, elapsedMs: 0 };
}

export class RunError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunError';
  }
}
