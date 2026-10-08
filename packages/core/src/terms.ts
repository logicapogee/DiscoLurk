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

/** A category as addressed on its site; `path` is the list URL path such as `/c/develop/4` (Appendix C). */
export interface Category {
  name: string;
  path: string;
  id: number;
  enabledByDefault: boolean;
}

/** §2.2 */
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

/** §8.3 */
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
 * their title link on the list page (T08), so nothing downstream can navigate to them directly.
 */
export interface TopicCandidate {
  id: string;
  title: string;
  unread: boolean;
  pinned: boolean;
}

export type RunModeSpec =
  | { kind: 'endless' }
  | { kind: 'topics'; min: number; max: number }
  | { kind: 'time'; minutes: number };

/** A run mode whose random range has been fixed at materialization (§9.1). */
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

/** §2.2 / §11.1 */
export interface RunPreset {
  id: PresetId;
  siteId: SiteId;
  browseMode: BrowseMode;
  runMode: RunModeSpec;
  categoryPaths: string[];
  interaction: InteractionPolicy;
  extraWait: WaitRange & { enabled: boolean };
  samplePerCategory: { min: number; max: number };
}

export interface ResolvedPreset {
  presetId: PresetId;
  browseMode: BrowseMode;
  runMode: RunMode;
  categories: Category[];
  interaction: InteractionPolicy;
  extraWait: WaitRange & { enabled: boolean };
  samplePerCategory: { min: number; max: number };
}

/** §9.1 */
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
