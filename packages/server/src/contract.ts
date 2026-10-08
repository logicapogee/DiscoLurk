// Wire types of the sidecar's REST and WebSocket API. This module imports only kernel types, so the
// UI can import it without pulling Node code into a browser bundle.
import type {
  BrowserChannel,
  BrowserMode,
  Category,
  ProfileHealth,
  ProfileId,
  ProfileStatus,
  RunEvent,
  RunId,
  RunPlanSnapshot,
  RunPreset,
  RunResult,
  RunState,
  ScheduleSpec,
  ScheduleView,
  Site,
  SiteId,
} from '@disco-lurk/core';

export interface SiteView {
  site: Site;
  categories: Category[];
}

export interface ProfileView {
  id: ProfileId;
  siteId: SiteId;
  name: string;
  channel: BrowserChannel;
  proxy?: string;
  executablePath?: string;
  /** `locked` while this sidecar or another process holds the Profile. */
  status: ProfileStatus | 'unknown';
  /** The last health check, if one ran. */
  health?: ProfileHealth;
  busy: boolean;
}

export interface ProfileCreate {
  siteId: SiteId;
  name: string;
  channel: BrowserChannel;
  proxy?: string | undefined;
}

/**
 * The browser executable is deliberately not settable here: whoever holds the token (a remote
 * `serve` client included) could otherwise make the host launch any program.
 */
export interface ProfilePatch {
  proxy?: string | null | undefined;
}

/** A saved run configuration plus where and how it runs. */
export interface StoredPreset extends RunPreset {
  name: string;
  profileId: ProfileId | null;
  browserMode: BrowserMode;
}

export interface PresetSave {
  preset: StoredPreset;
  /** Required whenever `interaction.reply.enabled` is true: automatic replies post as the user. */
  confirmReply?: boolean | undefined;
}

export interface ActiveRun {
  runId: RunId;
  presetId: string;
  presetName: string;
  plan: RunPlanSnapshot;
  startedAt: string;
  state: RunState;
  stopping: boolean;
  /** Settled once the run has ended; the record then moves to history. */
  result?: RunResult;
}

export interface RunRecord {
  runId: RunId;
  presetId: string;
  presetName: string;
  plan: RunPlanSnapshot;
  startedAt: string;
  endedAt: string;
  result: RunResult;
}

export type LoginPhase = 'opening' | 'waiting' | 'needs-auth' | 'challenge-detected' | 'checking-health' | 'done' | 'failed' | 'closed';

export interface LoginView {
  profileId: ProfileId;
  phase: LoginPhase;
  /** Epoch ms when the current wait gives up; set while `waiting`. */
  deadline?: number;
  username?: string;
  health?: ProfileHealth;
  message?: string;
}

export interface Settings {
  notifications: boolean;
  closeToTray: boolean;
  updateCheck: boolean;
  /** The preset the tray's start entry runs; the last one started from the UI. */
  currentPresetId: string | null;
  language: 'zh-CN';
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  releaseUrl: string;
}

export interface ScheduleList {
  /** Specs live in memory until schedules are persisted to disk. */
  persisted: false;
  schedules: ScheduleView[];
}

export type ScheduleSave = ScheduleSpec;

export interface ServerInfo {
  version: string;
  /** No display: runs are forced headless and headed sign-in is refused. */
  headlessOnly: boolean;
  platform: string;
}

export interface ErrorBody {
  error: string;
  message?: string;
}

/** Frames the server pushes on `/events` after the first-frame auth. */
export type ServerFrame =
  | { type: 'auth-ok' }
  | { type: 'heartbeat'; at: string }
  | { type: 'event'; runId: RunId; event: RunEvent }
  | { type: 'run'; run: ActiveRun }
  | { type: 'login'; login: LoginView }
  | { type: 'profiles-changed' }
  | { type: 'settings'; settings: Settings };

export const HEARTBEAT_MS = 15_000;
