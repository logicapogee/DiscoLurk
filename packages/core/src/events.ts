import type { LevelSnapshot, MetricKey } from './metrics';
import type { ActionReport, ReadVerification } from './ports';

/** The states a run moves through, ending in `completed`, `failed` or `cancelled`. */
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

/** Every failure a run can report; each maps to a CLI exit code. */
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

interface StatCounters {
  topics: number;
  floors: number;
  likes: number;
  replyLikes: number;
  replies: number;
}

export interface RunStats {
  attempted: StatCounters;
  /** `repliedTopics` counts topics with at least one confirmed reply, matching connect's 回复话题. */
  confirmed: StatCounters & { repliedTopics: number };
  estimatedFloors: number;
  /** How each entered topic's list row looked on the way back. */
  returns: Record<ReadVerification, number>;
  /**
   * What the site's own `/topics/timings` flushes acknowledged: distinct floors and the summed
   * topic time. It is the browser's read receipt, so it sits between confirmed and reported.
   */
  timings: { posts: number; topicSeconds: number };
  reported?: Partial<Record<MetricKey, { initial?: number; final: number }>>;
  /** Measured on the monotonic clock. */
  elapsedMs: number;
}

export type RunEvent =
  | { type: 'state'; at: string; state: RunState }
  | { type: 'topic'; at: string; topicId: string; phase: 'click' | 'entered' | 'read' | 'returned'; result?: string }
  | { type: 'floor'; at: string; from: number; to: number; confirmed: boolean }
  | { type: 'action'; at: string; action: 'like' | 'reply'; result: 'attempted' | 'confirmed' | 'rejected' }
  | { type: 'timings'; at: string; postsReported: number; topicSeconds: number }
  | { type: 'stats'; at: string; stats: RunStats }
  /** The progress page as read before browsing and after it; a re-read after the site's lag sends `final` again. */
  | { type: 'levels'; at: string; kind: 'initial' | 'final'; snapshot: LevelSnapshot }
  | { type: 'warning'; at: string; code: string; message: string }
  | { type: 'error'; at: string; error: RunFailure };

/** The terminal state a run reached. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * Why browsing ended. A user stop that still verified ends in `completed` (stopping →
 * verifying → completed), so callers read the cause, not the outcome, to tell it from a met target.
 */
export type StopCause = 'target' | StopRequest | 'no-progress' | 'error';

export interface RunResult {
  outcome: RunOutcome;
  stopCause: StopCause;
  stats: RunStats;
  failure?: RunFailure;
  /** `missing` when the initial progress read failed; `not-applicable` for `progressSource: 'none'`. */
  baseline: 'present' | 'missing' | 'not-applicable';
  /** The progress page as read before and after browsing; null where it was not read. */
  levels: { initial: LevelSnapshot | null; final: LevelSnapshot | null };
}

/**
 * Abort reasons a run's signal carries, so the coordinator can tell a user stop from the app
 * exiting or the browser window being closed from outside.
 */
export type StopRequest = 'user' | 'app-exit' | 'browser-closed';

const STOP_REQUESTS: readonly StopRequest[] = ['user', 'app-exit', 'browser-closed'];

export function stopRequest(reason: StopRequest): DOMException {
  return new DOMException(reason, 'AbortError');
}

/** A plain `abort()` without one of these reasons counts as a user stop. */
export function stopRequestOf(signal: AbortSignal): StopRequest {
  const reason: unknown = signal.reason;
  const named = reason instanceof DOMException ? STOP_REQUESTS.find((r) => r === reason.message) : undefined;
  return named ?? 'user';
}

function emptyCounters(): StatCounters {
  return { topics: 0, floors: 0, likes: 0, replyLikes: 0, replies: 0 };
}

/** The counter each action bucket lands in. */
const ACTION_COUNTERS = { topic: 'likes', reply: 'replyLikes', 'reply-post': 'replies' } as const satisfies Record<ActionReport['bucket'], keyof StatCounters>;

/** Adds one action report to the counters its bucket names; a rejection adds to neither. */
export function addActionReport(stats: RunStats, report: ActionReport): void {
  const counter = ACTION_COUNTERS[report.bucket];
  if (report.result === 'attempted') stats.attempted[counter]++;
  else if (report.result === 'confirmed') stats.confirmed[counter]++;
}

export function emptyStats(): RunStats {
  return {
    attempted: emptyCounters(),
    confirmed: { ...emptyCounters(), repliedTopics: 0 },
    estimatedFloors: 0,
    returns: { confirmed: 0, 'still-unread': 0, indeterminate: 0, 'not-applicable': 0 },
    timings: { posts: 0, topicSeconds: 0 },
    elapsedMs: 0,
  };
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

export function toFailure(err: unknown): RunFailure {
  if (err instanceof RunError) return { code: err.code, message: err.message };
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}
