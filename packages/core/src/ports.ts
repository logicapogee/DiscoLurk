import type { RunEvent, RunResult } from './events';
import type { LevelSnapshot } from './metrics';
import type {
  BrowseMode,
  BrowserMode,
  Category,
  InteractionPolicy,
  ProfileHealth,
  WaitRange,
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

/** A category's own topic list, or one of its filtered lists. */
export type TopicListSource = 'category' | 'new' | 'unread';

export interface TopicStrategy {
  /** Deep mode sorts the list by reply count. */
  browseMode: BrowseMode;
  /**
   * Filtered lists to try first, in order; the first that shows a clickable topic is used and the
   * category's own list is the fallback. Empty or absent means the category's own list only.
   */
  lists?: ReadonlyArray<Exclude<TopicListSource, 'category'>>;
}

/** No topics means the list had nothing to click; the category is skipped as `empty-category`. */
export interface TopicBatch {
  category: Category;
  /** The list the topics were read from, which is the page their title links are clicked on. */
  source: TopicListSource;
  topics: TopicCandidate[];
}

export type TopicVisit =
  | { topic: TopicCandidate; entered: true }
  | { topic: TopicCandidate; entered: false; reason: string };

export interface FloorAdvance {
  from: number;
  to: number;
  /** False for estimates made without a floor counter. */
  confirmed: boolean;
}

export interface ReadStrategy {
  browseMode: BrowseMode;
  /**
   * Called on every floor change. Returning `'stop'` ends the topic: the target was reached,
   * so further scrolling and interaction must not happen.
   */
  onFloor(advance: FloorAdvance): 'continue' | 'stop';
}

export interface ReadResult {
  startFloor: number | null;
  endFloor: number | null;
  scrolls: number;
  stoppedByTarget: boolean;
  /** Which floor counter layout the last reading came from; null when none rendered. */
  layout: 'wide' | 'narrow' | null;
}

export interface ActionReport {
  action: 'like' | 'reply';
  /** `rejected` is an action that was sent but never confirmed by the page. */
  result: 'attempted' | 'confirmed' | 'rejected';
  postNumber?: number;
}

/** The interaction switches and rates, the extra-wait setting that paces them, and where each action is reported. */
export interface ActionPolicy extends InteractionPolicy {
  extraWait: WaitRange & { enabled: boolean };
  onAction(report: ActionReport): void;
}

export interface ActionResult {
  likes: { attempted: number; confirmed: number };
  replyLikes: { attempted: number; confirmed: number };
  replies: { attempted: number; confirmed: number };
  /** Set once likes went unconfirmed twice in a row, the sign of the site's daily like limit. */
  likeLimitHit: boolean;
}

/**
 * How the list row looked on return. `not-applicable` is a topic that had no `new-topic` badge before it was entered: its row was
 * found again, but there is no badge whose disappearance could confirm anything.
 */
export type ReadVerification = 'confirmed' | 'still-unread' | 'indeterminate' | 'not-applicable';

/** The site seam. Selectors, waits and error classification live behind it. */
export interface ForumPort {
  readonly site: Site;
  ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult>;
  discoverCategories(signal: AbortSignal): Promise<Category[]>;
  /**
   * Resolves to null when the site's `progressSource` is `'none'`. `kind` tells the end-of-run
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

/** When a schedule fires: a cron expression or a number of random runs inside a daily window. */
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
  /** The already materialized snapshot that will run next. */
  next: RunPlanSnapshot | null;
}

export interface Scheduler {
  reconcile(specs: ScheduleSpec[]): Promise<ScheduleView[]>;
  trigger(scheduleId: ScheduleId, cause: TriggerCause): Promise<RunId>;
  pause(scheduleId: ScheduleId): Promise<void>;
}
