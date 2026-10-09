import type { Clock, ProfileHealth, ProfileId } from '@disco-lurk/core';
import type { ActiveRun, LoggedEvent } from '../contract';
import type { EventHub } from '../hub';
import type { LoginManager } from '../logins';
import type { ProfileGate, RunManager, SiteCatalog } from '../runs';
import type { ScheduleService } from '../schedules';
import type { Reply } from '../server';
import type { PresetStore, ProfileRegistry, RunHistory, SettingsStore } from '../store';

/** What every route module works with: the app's stores and services plus the checks they share. */
export interface AppContext {
  clock: Clock;
  dataDir: string;
  headlessOnly: boolean;
  log(message: string): void;
  hub: EventHub;
  gate: ProfileGate;
  settings: SettingsStore;
  presets: PresetStore;
  history: RunHistory;
  catalog: SiteCatalog;
  profiles: ProfileRegistry;
  runs: RunManager;
  logins: LoginManager;
  schedules: ScheduleService;
  /** The Profile `:site/:name` names; 404 when it does not exist. */
  withProfile(params: Record<string, string>): Promise<ProfileId>;
  requireProfile(id: ProfileId): Promise<void>;
  /** A lock held by another process (a CLI run) is a conflict now, not a failed run later. */
  requireFree(id: ProfileId): Promise<void>;
  /** A headless health check of a free Profile; the result is stored and the Profile list published once. */
  inspect(id: ProfileId): Promise<ProfileHealth>;
  /** Stores a health check and reloads its site's categories. */
  recordHealth(health: ProfileHealth): Promise<void>;
  publishProfiles(): Promise<void>;
  startPreset(presetId: string): Promise<ActiveRun>;
  /** The run's stored events, optionally only some types; lines a crash cut short are skipped and logged. */
  runLog(runId: string, types: readonly string[] | null): Promise<{ events: LoggedEvent[]; skipped: number }>;
}

export const ok = (body: unknown, status = 200): Reply => ({ status, body });

/** The clock's time as a file-name-safe stamp. */
export const stamp = (clock: Clock) => new Date(clock.now()).toISOString().replace(/[:.]/g, '-');

export const safeFileName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');
