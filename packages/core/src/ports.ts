import type { RunEvent, RunFailure, RunResult } from './events';
import type { LevelSnapshot } from './metrics';
import type {
  BrowseMode,
  BrowserMode,
  Category,
  InteractionPolicy,
  ProfileHealth,
  ProfileId,
  RunId,
  RunPlanSnapshot,
  ScheduleId,
  Site,
  TopicCandidate,
} from './terms';

export type AuthMode = 'headed-wait' | 'headless-check' | 'credentials';

export type AuthResult =
  | { status: 'authenticated'; username?: string }
  | { status: 'needs-auth' }
  | { status: 'challenge-detected' }
  | { status: 'failed'; failure: RunFailure };

export interface TopicStrategy {
  /** Deep mode sorts the list by reply count (T02). */
  browseMode: BrowseMode;
}

export interface TopicBatch {
  category: Category;
  topics: TopicCandidate[];
  /** The list never rendered a topic row (§7.1 step 2); the category is skipped as `empty-category`. */
  empty: boolean;
}

export type TopicVisit =
  | { topic: TopicCandidate; entered: true }
  | { topic: TopicCandidate; entered: false; reason: string };

export interface FloorAdvance {
  from: number;
  to: number;
  /** False for blind-scroll estimates (F08, Q04). */
  confirmed: boolean;
}

export interface ReadStrategy {
  browseMode: BrowseMode;
  /**
   * Called on every floor change (F06). Returning `'stop'` ends the topic: the target was reached,
   * so further scrolling and interaction must not happen.
   */
  onFloor(advance: FloorAdvance): 'continue' | 'stop';
}

export interface ReadResult {
  startFloor: number | null;
  endFloor: number | null;
  scrolls: number;
  stoppedByTarget: boolean;
  /** Which floor counter layout (§4.3) the last reading came from; null when none rendered. */
  layout: 'wide' | 'narrow' | null;
}

export interface ActionPolicy extends InteractionPolicy {}

export interface ActionResult {
  likes: { attempted: number; confirmed: number };
  replyLikes: { attempted: number; confirmed: number };
  replies: { attempted: number; confirmed: number };
  likeLimitHit: boolean;
}

/** T11 */
export type ReadVerification = 'confirmed' | 'still-unread' | 'indeterminate';

/** §6.1: the site seam. Selectors, waits and error classification live behind it. */
export interface ForumPort {
  readonly site: Site;
  ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult>;
  discoverCategories(signal: AbortSignal): Promise<Category[]>;
  /** Resolves to null when the site's `progressSource` is `'none'`. */
  readProgress(kind: 'initial' | 'final', signal: AbortSignal): Promise<LevelSnapshot | null>;
  collectTopics(category: Category, strategy: TopicStrategy, signal: AbortSignal): Promise<TopicBatch>;
  enterFromList(topic: TopicCandidate, signal: AbortSignal): Promise<TopicVisit>;
  readTopic(visit: TopicVisit, strategy: ReadStrategy, signal: AbortSignal): Promise<ReadResult>;
  performActions(policy: ActionPolicy, signal: AbortSignal): Promise<ActionResult>;
  returnAndVerify(visit: TopicVisit, signal: AbortSignal): Promise<ReadVerification>;
}

export interface AuthSession {
  recheck(): Promise<AuthResult>;
  continueWaiting(signal: AbortSignal): Promise<AuthResult>;
  /** Releases the browser and the Profile lock. */
  close(): Promise<void>;
}

export interface RunCoordinator {
  run(plan: RunPlanSnapshot, signal: AbortSignal, emit: (e: RunEvent) => void): Promise<RunResult>;
  inspect(profileId: ProfileId): Promise<ProfileHealth>;
  beginAuth(profileId: ProfileId): Promise<AuthSession>;
}

/** §9.1 */
export type ScheduleTrigger =
  | { kind: 'cron'; expression: string }
  | {
      kind: 'daily-window';
      runs: number;
      start: string;
      end: string;
      jitterMinutes: number;
      minGapMinutes: number;
    };

export interface ScheduleSpec {
  id: ScheduleId;
  name: string;
  profileId: ProfileId;
  presetId: string;
  enabled: boolean;
  browserMode: BrowserMode;
  timezone: string;
  trigger: ScheduleTrigger;
  misfire: { policy: 'skip' | 'run-once'; graceMinutes: number };
  overlap: 'skip';
  unavailableDisplay: 'skip' | 'fallback-headless';
  runOnStart: boolean;
}

export type TriggerCause = 'planned' | 'run-on-start' | 'misfire' | 'manual';

export interface ScheduleView {
  spec: ScheduleSpec;
  paused: boolean;
  /** The already materialized snapshot that will run next (§9.1). */
  next: RunPlanSnapshot | null;
}

export interface Scheduler {
  reconcile(specs: ScheduleSpec[]): Promise<ScheduleView[]>;
  trigger(scheduleId: ScheduleId, cause: TriggerCause): Promise<RunId>;
  pause(scheduleId: ScheduleId): Promise<void>;
}
