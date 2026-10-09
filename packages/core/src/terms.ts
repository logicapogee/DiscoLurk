export type SiteId = string;
export type ProfileId = string;
export type PresetId = string;
export type ScheduleId = string;
export type RunId = string;

export type ProgressSource = 'connect-linuxdo' | 'trust-level-docofcard' | 'none';
export type LoginMethod = 'headed' | 'password';
export type CategorySource = 'builtin' | 'discovered';
export type BrowserChannel = 'chrome' | 'msedge';
export type BrowserMode = 'headed' | 'headless';
export type BrowseMode = 'deep' | 'quick';

/** A category as addressed on its site; `path` is the list URL path such as `/c/develop/4`. */
export interface Category {
  name: string;
  path: string;
  id: number;
  enabledByDefault: boolean;
}

/** A forum the app can browse, and everything that differs between forums. */
export interface Site {
  id: SiteId;
  displayName: string;
  baseUrl: string;
  kind: 'discourse';
  login: LoginMethod;
  categorySource: CategorySource;
  builtinCategories?: Category[];
  progressSource: ProgressSource;
  progressUrl?: string;
  behaviorVerified: { clickEntryRequired: boolean | 'unverified' };
}

/** A browser Profile: one app-owned user data directory per site and name. */
export type ProfileStatus = 'ready' | 'needs-auth' | 'locked' | 'recovering' | 'broken';

export interface Profile {
  id: ProfileId;
  siteId: SiteId;
  channel: BrowserChannel;
  executablePath?: string;
  proxy?: string;
}

export interface ProfileHealth {
  profileId: ProfileId;
  status: ProfileStatus;
  username?: string;
  checkedAt: string;
}

/**
 * A list-page row. It deliberately carries no URL: candidates are entered only by clicking
 * their title link on the list page, so nothing downstream can navigate to them directly.
 */
export interface TopicCandidate {
  id: string;
  title: string;
  unread: boolean;
  pinned: boolean;
  /** The row's `unread-posts` badge: visited before, with posts added since. */
  unreadPosts?: boolean;
  /** The reply count the row shows, when it could be read. */
  replies?: number;
}

export type RunModeSpec =
  | { kind: 'endless' }
  | { kind: 'topics'; min: number; max: number }
  | { kind: 'time'; minutes: number };

/** A run mode whose random range has been fixed at materialization. */
export type RunMode =
  | { kind: 'endless' }
  | { kind: 'topics'; count: number }
  | { kind: 'time'; minutes: number };

export interface WaitRange {
  minSec: number;
  maxSec: number;
}

export interface InteractionPolicy {
  like: { enabled: boolean; topicRate: number; replyRate: number; maxReplies: number };
  reply: { enabled: boolean; rate: number };
}

/**
 * Switches that stay off until live checks show they leave the site's counting intact.
 * `useNewList` / `useUnreadList` pick candidates from a category's `/l/new` or `/l/unread` list
 * first; `refreshCategories` re-reads a builtin site's category paths before browsing;
 * `smartRanked` orders candidates by the visit ledger instead of drawing them at random.
 */
export interface ExperimentFlags {
  useNewList: boolean;
  useUnreadList: boolean;
  refreshCategories: boolean;
  smartRanked: boolean;
}

export const EXPERIMENTS_OFF: Readonly<ExperimentFlags> = Object.freeze({
  useNewList: false,
  useUnreadList: false,
  refreshCategories: false,
  smartRanked: false,
});

/** What a run does: browse mode, target, categories, interactions and waits. */
export interface RunPreset {
  id: PresetId;
  siteId: SiteId;
  browseMode: BrowseMode;
  runMode: RunModeSpec;
  categoryPaths: string[];
  interaction: InteractionPolicy;
  extraWait: WaitRange & { enabled: boolean };
  samplePerCategory: { min: number; max: number };
  /** Absent means every experiment is off. */
  experiments?: ExperimentFlags;
}

export interface ResolvedPreset {
  presetId: PresetId;
  browseMode: BrowseMode;
  runMode: RunMode;
  categories: Category[];
  interaction: InteractionPolicy;
  extraWait: WaitRange & { enabled: boolean };
  samplePerCategory: { min: number; max: number };
  experiments: ExperimentFlags;
}

/** One run fixed in advance: every random choice is drawn from `seed`, so the snapshot replays exactly. */
export interface RunPlanSnapshot {
  id: RunId;
  scheduleId?: ScheduleId;
  siteId: SiteId;
  profileId: ProfileId;
  browserMode: BrowserMode;
  preset: ResolvedPreset;
  seed: number;
  plannedAt: string;
  materializedAt: string;
}
