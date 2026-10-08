import { appendFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '@disco-lurk/config';
import { emptyStats, type BrowserChannel, type Profile, type ProfileHealth, type ProfileId, type RunEvent, type RunStats } from '@disco-lurk/core';
import type { ProfileCreate, ProfilePatch, ProfileView, RunRecord, Settings, StoredPreset } from './contract';
import { HttpError } from './server';

async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix or delete it`);
  }
}

/** Writes are queued so two quick saves land in call order and never share a temp file. */
class Serial {
  private last: Promise<void> = Promise.resolve();
  run(task: () => Promise<void>): Promise<void> {
    const next = this.last.catch(() => {}).then(task);
    this.last = next;
    return next;
  }
}

export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  closeToTray: true,
  updateCheck: true,
  currentPresetId: null,
  language: 'zh-CN',
};

export class SettingsStore {
  private value: Settings = { ...DEFAULT_SETTINGS };
  private serial = new Serial();

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    const file = await readJson<{ schemaVersion: 1; settings: Partial<Settings> }>(this.path);
    this.value = { ...DEFAULT_SETTINGS, ...(file?.settings ?? {}) };
    return this.get();
  }

  get(): Settings {
    return { ...this.value };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.value = { ...this.value, ...patch };
    const snapshot = this.get();
    await this.serial.run(() => writeJsonAtomic(this.path, { schemaVersion: 1, settings: snapshot }));
    return snapshot;
  }
}

export class PresetStore {
  private presets = new Map<string, StoredPreset>();
  private serial = new Serial();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const file = await readJson<{ schemaVersion: 1; presets: StoredPreset[] }>(this.path);
    this.presets = new Map((file?.presets ?? []).map((p) => [p.id, p]));
  }

  list(): StoredPreset[] {
    return [...this.presets.values()].map((p) => structuredClone(p));
  }

  get(id: string): StoredPreset | undefined {
    const p = this.presets.get(id);
    return p ? structuredClone(p) : undefined;
  }

  private persist(): Promise<void> {
    const presets = this.list();
    return this.serial.run(() => writeJsonAtomic(this.path, { schemaVersion: 1, presets }));
  }

  async put(preset: StoredPreset): Promise<void> {
    this.presets.set(preset.id, structuredClone(preset));
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    if (!this.presets.delete(id)) return false;
    await this.persist();
    return true;
  }
}

interface ProfileMeta {
  channel: BrowserChannel;
  proxy?: string;
  /** Only ever set by editing profiles.json by hand on the host; the API cannot write it. */
  executablePath?: string;
  health?: ProfileHealth;
}

/** Reports the live process holding a Profile directory, or null when none does. */
export type LockHolder = (profileDir: string) => Promise<number | null>;

/**
 * Profiles are directories `<profilesDir>/<siteId>/<name>`; settings the directory cannot carry
 * (channel, proxy, last health) sit in one file beside them. A directory made by `lurk login`
 * shows up too, with the CLI's default channel.
 */
export class ProfileRegistry {
  private meta: Record<ProfileId, ProfileMeta> = {};
  private serial = new Serial();

  constructor(
    private readonly metaPath: string,
    private readonly profilesDir: string,
    private readonly backupsDir: string,
    private readonly siteIds: () => string[],
    private readonly lockHolder: LockHolder,
  ) {}

  async load(): Promise<void> {
    const file = await readJson<{ schemaVersion: 1; profiles: Record<ProfileId, ProfileMeta> }>(this.metaPath);
    this.meta = file?.profiles ?? {};
  }

  dirOf(profileId: ProfileId): string {
    const { siteId, name } = splitProfileId(profileId);
    return join(this.profilesDir, siteId, name);
  }

  private persist(): Promise<void> {
    const profiles = structuredClone(this.meta);
    return this.serial.run(() => writeJsonAtomic(this.metaPath, { schemaVersion: 1, profiles }));
  }

  private async ids(): Promise<ProfileId[]> {
    const found = new Set(Object.keys(this.meta));
    for (const siteId of this.siteIds()) {
      const entries = await readdir(join(this.profilesDir, siteId), { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory() && NAME.test(e.name)) found.add(`${siteId}/${e.name}`);
    }
    return [...found].filter((id) => this.siteIds().includes(splitProfileId(id).siteId)).sort();
  }

  async exists(profileId: ProfileId): Promise<boolean> {
    return (await this.ids()).includes(profileId);
  }

  async list(busy: (id: ProfileId) => boolean): Promise<ProfileView[]> {
    const out: ProfileView[] = [];
    for (const id of await this.ids()) {
      const { siteId, name } = splitProfileId(id);
      const m = this.meta[id] ?? { channel: 'chrome' };
      const isBusy = busy(id);
      const holder = isBusy ? null : await this.lockHolder(this.dirOf(id));
      out.push({
        id,
        siteId,
        name,
        channel: m.channel,
        ...(m.proxy ? { proxy: m.proxy } : {}),
        ...(m.executablePath ? { executablePath: m.executablePath } : {}),
        status: isBusy || holder !== null ? 'locked' : (m.health?.status ?? 'unknown'),
        ...(m.health ? { health: m.health } : {}),
        busy: isBusy,
      });
    }
    return out;
  }

  async resolve(profileId: ProfileId): Promise<Profile> {
    const { siteId } = splitProfileId(profileId);
    const m = this.meta[profileId] ?? { channel: 'chrome' };
    return {
      id: profileId,
      siteId,
      channel: m.channel,
      ...(m.proxy ? { proxy: m.proxy } : {}),
      ...(m.executablePath ? { executablePath: m.executablePath } : {}),
    };
  }

  async create(req: ProfileCreate): Promise<void> {
    const id = `${req.siteId}/${req.name}`;
    if (await this.exists(id)) throw new HttpError(409, 'profile-exists', `Profile ${id} already exists`);
    await mkdir(this.dirOf(id), { recursive: true });
    this.meta[id] = { channel: req.channel, ...(req.proxy ? { proxy: req.proxy } : {}) };
    await this.persist();
  }

  async patch(profileId: ProfileId, patch: ProfilePatch): Promise<void> {
    const m: ProfileMeta = { ...(this.meta[profileId] ?? { channel: 'chrome' }) };
    if (patch.proxy !== undefined) {
      if (patch.proxy === null) delete m.proxy;
      else m.proxy = patch.proxy;
    }
    this.meta[profileId] = m;
    await this.persist();
  }

  async setHealth(health: ProfileHealth): Promise<void> {
    this.meta[health.profileId] = { ...(this.meta[health.profileId] ?? { channel: 'chrome' }), health };
    await this.persist();
  }

  /** Deleting the directory deletes the sign-in it holds; the UI asks first. */
  async remove(profileId: ProfileId): Promise<void> {
    await rm(this.dirOf(profileId), { recursive: true, force: true });
    delete this.meta[profileId];
    await this.persist();
  }

  async backup(profileId: ProfileId, stamp: string): Promise<string> {
    const { siteId, name } = splitProfileId(profileId);
    const target = join(this.backupsDir, `${siteId}-${name}-${stamp}`);
    // The lock belongs to whoever runs the Profile, not to a copy of it.
    await cp(this.dirOf(profileId), target, { recursive: true, filter: (src) => !src.endsWith('.lurk-lock') });
    return target;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function splitProfileId(profileId: ProfileId): { siteId: string; name: string } {
  const [siteId, name, ...rest] = profileId.split('/');
  if (!siteId || !name || rest.length > 0 || !NAME.test(name)) throw new HttpError(400, 'invalid-profile-id', `Invalid Profile id ${profileId}`);
  return { siteId, name };
}

export const HISTORY_LIMIT = 200;

/** EPERM means the process exists but belongs to someone else. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const safeName = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, '_');

function lastStats(lines: string[]): RunStats | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as RunEvent;
      if (e.type === 'stats') return e.stats;
    } catch {
      // a line cut short by the crash
    }
  }
  return undefined;
}

/**
 * The last runs as JSONL, one RunRecord per line, plus each run's event stream in its own JSONL
 * file. Records past the limit are dropped together with their event files.
 */
export class RunHistory {
  private records: RunRecord[] = [];
  private serial = new Serial();

  constructor(
    private readonly dir: string,
    private readonly limit = HISTORY_LIMIT,
  ) {}

  private get indexPath() {
    return join(this.dir, 'history.jsonl');
  }

  eventsPath(runId: string): string {
    return join(this.dir, `${safeName(runId)}.events.jsonl`);
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const raw = await readFile(this.indexPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    // A line cut short by a crash mid-append is skipped; every complete line before it still loads.
    this.records = raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunRecord];
        } catch {
          return [];
        }
      })
      .slice(-this.limit);
  }

  list(limit = this.limit): RunRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get(runId: string): RunRecord | undefined {
    return this.records.find((r) => r.runId === runId);
  }

  private get openPath() {
    return join(this.dir, 'open');
  }

  /**
   * Marks a run as in progress. A sidecar that dies mid-run leaves the mark behind, and the next
   * one records that run as failed instead of losing it.
   */
  markOpen(record: Omit<RunRecord, 'endedAt' | 'result'>): Promise<void> {
    return this.serial.run(async () => {
      await mkdir(this.openPath, { recursive: true });
      await writeFile(join(this.openPath, `${safeName(record.runId)}.json`), JSON.stringify({ ...record, pid: process.pid }));
    });
  }

  private clearOpen(runId: string): Promise<void> {
    return rm(join(this.openPath, `${safeName(runId)}.json`), { force: true });
  }

  /**
   * Runs a dead process left open, as failed records; returns how many were recovered. A mark whose
   * process still lives belongs to another sidecar on the same data directory and is left alone.
   */
  async recoverOpen(endedAt: string, isAlive: (pid: number) => boolean = pidAlive): Promise<number> {
    const names = await readdir(this.openPath).catch(() => [] as string[]);
    let recovered = 0;
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const raw = await readFile(join(this.openPath, name), 'utf8').catch(() => null);
      let mark: (Omit<RunRecord, 'endedAt' | 'result'> & { pid: number }) | null = null;
      try {
        mark = raw ? (JSON.parse(raw) as Omit<RunRecord, 'endedAt' | 'result'> & { pid: number }) : null;
      } catch {
        mark = null;
      }
      if (mark && isAlive(mark.pid)) continue;
      if (mark && !this.get(mark.runId)) {
        const { pid: _pid, ...open } = mark;
        await this.add({
          ...open,
          endedAt,
          result: {
            outcome: 'failed',
            stopCause: 'error',
            stats: lastStats(await this.readEvents(mark.runId)) ?? emptyStats(),
            failure: { code: 'internal', message: 'The sidecar stopped while this run was in progress' },
            baseline: 'missing',
            levels: { initial: null, final: null },
          },
        });
        recovered++;
      }
      await rm(join(this.openPath, name), { force: true });
    }
    return recovered;
  }

  appendEvent(runId: string, line: string): Promise<void> {
    return this.serial.run(() => appendFile(this.eventsPath(runId), line + '\n'));
  }

  async readEvents(runId: string): Promise<string[]> {
    await this.serial.run(async () => {});
    const raw = await readFile(this.eventsPath(runId), 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean);
  }

  add(record: RunRecord): Promise<void> {
    void this.serial.run(() => this.clearOpen(record.runId));
    this.records.push(record);
    const dropped = this.records.length > this.limit ? this.records.splice(0, this.records.length - this.limit) : [];
    const kept = this.records.slice();
    return this.serial.run(async () => {
      if (dropped.length === 0) {
        await appendFile(this.indexPath, JSON.stringify(record) + '\n');
        return;
      }
      const tmp = `${this.indexPath}.tmp`;
      await writeFile(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
      await rename(tmp, this.indexPath);
      for (const r of dropped) await rm(this.eventsPath(r.runId), { force: true });
    });
  }

  flush(): Promise<void> {
    return this.serial.run(async () => {});
  }
}
