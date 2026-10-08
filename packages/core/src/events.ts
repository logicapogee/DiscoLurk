import type { LevelSnapshot, MetricKey } from './metrics';

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
  /** `repliedTopics` counts topics with at least one confirmed reply, matching connect's 回复话题. */
  confirmed: StatCounters & { repliedTopics: number };
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

/** The terminal state a run reached (§6.2). */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * Why browsing ended. A user stop that still verified ends in `completed` (§6.2 stopping →
 * verifying → completed), so callers read the cause, not the outcome, to tell it from a met target.
 */
export type StopCause = 'target' | StopRequest | 'no-progress' | 'error';

export interface RunResult {
  outcome: RunOutcome;
  stopCause: StopCause;
  stats: RunStats;
  failure?: RunFailure;
  /** S09: `missing` when the initial progress read failed; `not-applicable` for `progressSource: 'none'`. */
  baseline: 'present' | 'missing' | 'not-applicable';
  /** The progress page as read before and after browsing (S07/S08); null where it was not read. */
  levels: { initial: LevelSnapshot | null; final: LevelSnapshot | null };
}

/**
 * Abort reasons a run's signal carries, so the coordinator can tell a user stop from the app
 * exiting or the browser window being closed from outside (§6.2).
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

export function emptyCounters(): StatCounters {
  return { topics: 0, floors: 0, likes: 0, replyLikes: 0, replies: 0 };
}

export function emptyStats(): RunStats {
  return { attempted: emptyCounters(), confirmed: { ...emptyCounters(), repliedTopics: 0 }, estimatedFloors: 0, elapsedMs: 0 };
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
