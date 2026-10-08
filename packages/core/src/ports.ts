import type { RunEvent, RunResult } from './events';
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

/** Page and network failures are thrown as `RunError`; these are the answers a working page can give. */
export type AuthResult =
  | { status: 'authenticated'; username?: string }
  | { status: 'needs-auth' }
  | { status: 'challenge-detected' };

export interface TopicStrategy {
  /** Deep mode sorts the list by reply count (T02). */
  browseMode: BrowseMode;
}

/** No topics means the list had nothing to click (§7.1 step 2); the category is skipped as `empty-category`. */
export interface TopicBatch {
  category: Category;
  topics: TopicCandidate[];
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

/**
 * T11. `not-applicable` is a topic that had no `new-topic` badge before it was entered: its row was
 * found again, but there is no badge whose disappearance could confirm anything.
 */
export type ReadVerification = 'confirmed' | 'still-unread' | 'indeterminate' | 'not-applicable';

/** §6.1: the site seam. Selectors, waits and error classification live behind it. */
export interface ForumPort {
  readonly site: Site;
  ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult>;
  discoverCategories(signal: AbortSignal): Promise<Category[]>;
  /**
   * Resolves to null when the site's `progressSource` is `'none'`. `kind` tells the S07 end-of-run
   * read from the baseline, so an adapter can treat them differently (connect lags behind and may
   * need a later re-read); today both read the same way.
   */
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
