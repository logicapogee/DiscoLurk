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

/**
 * Automatic replies post under the user's name: a preset with `interaction.reply.enabled` is
 * accepted only with `interaction.reply.riskAcknowledged`, which the UI sets after its risk dialog.
 */
export interface PresetSave {
  preset: StoredPreset;
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

/** A run event as stored and pushed: `seq` counts up from 1 within the run, so a client merges stored and live events by it. */
export type LoggedEvent = RunEvent & { seq: number };

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
  /** Native notifications for runs that end, fail, need a sign-in or are skipped. */
  notifications: boolean;
  /** Also notify when a run starts; only applies while `notifications` is on. */
  notifyOnStart: boolean;
  updateCheck: boolean;
  /** The preset the tray's start entry runs; the last one started from the UI. */
  currentPresetId: string | null;
  language: 'zh-CN';
  /** Runs kept in history, with their event logs. */
  historyLimit: number;
  /** Days a Profile's visit ledger remembers a topic. */
  ledgerDays: number;
  /** What new presets start with for the advanced reading parameters. */
  reading: { samplePerCategory: { min: number; max: number }; extraWait: { enabled: boolean; minSec: number; maxSec: number } };
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  releaseUrl: string;
}

export interface ScheduleList {
  /** False while another process (a running `lurk serve`) owns the schedules; `reason` says which. */
  available: boolean;
  reason?: string;
  schedules: ScheduleView[];
}

/** One schedule's run history, oldest first; `ended` is set once a started run has finished. */
export interface ScheduleHistoryEntry {
  at: string;
  snapshotId: string;
  cause: 'planned' | 'run-on-start' | 'misfire' | 'manual';
  outcome: 'started' | 'skipped' | 'missed';
  reason?: string;
  runId?: RunId;
  ended?: { at: string; outcome: RunResult['outcome']; stopCause: RunResult['stopCause']; failure?: string };
}

export interface ServerInfo {
  version: string;
  /** No display: runs are forced headless and headed sign-in is refused. */
  headlessOnly: boolean;
  platform: string;
}

/** Frames the server pushes on `/events` after the first-frame auth. */
export type ServerFrame =
  | { type: 'auth-ok' }
  | { type: 'heartbeat'; at: string }
  | { type: 'event'; runId: RunId; event: LoggedEvent }
  /** Every state change of a run; once it has ended, `record` is the history entry it left. */
  | { type: 'run'; run: ActiveRun; record?: RunRecord }
  | { type: 'login'; login: LoginView }
  | { type: 'profiles-changed'; profiles: ProfileView[] }
  | { type: 'schedules'; list: ScheduleList }
  | { type: 'settings'; settings: Settings };

export const HEARTBEAT_MS = 15_000;
