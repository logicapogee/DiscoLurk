import type { Category, ProfileHealth, ScheduleSpec } from '@disco-lurk/core';
import type {
  ActiveRun,
  LoggedEvent,
  LoginView,
  ProfileCreate,
  ProfilePatch,
  ProfileView,
  RunRecord,
  ScheduleHistoryEntry,
  ScheduleList,
  ServerFrame,
  ServerInfo,
  Settings,
  SiteView,
  StoredPreset,
  UpdateInfo,
} from '@disco-lurk/server/contract';

export interface DoctorCheck {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  platform: string;
  arch: string;
  generatedAt: string;
  checks: DoctorCheck[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const seg = (profileId: string) => profileId.split('/').map(encodeURIComponent).join('/');

/** REST calls to the sidecar. The token travels only in the Authorization header. */
export class Api {
  constructor(
    readonly baseUrl: string,
    private token: string,
  ) {}

  setToken(token: string) {
    this.token = token;
  }

  get currentToken() {
    return this.token;
  }

  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let code = `http-${res.status}`;
      let message = `HTTP ${res.status}`;
      try {
        const b = (await res.json()) as { error?: string; message?: string };
        code = b.error ?? code;
        message = b.message ?? code;
      } catch {
        // a body that is not JSON keeps the status as the message
      }
      throw new ApiError(res.status, code, message);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  info = () => this.json<ServerInfo>('GET', '/info');
  doctor = () => this.json<DoctorReport>('GET', '/doctor');
  sites = () => this.json<SiteView[]>('GET', '/sites');
  defaultPreset = (siteId: string) => this.json<StoredPreset>('GET', `/sites/${encodeURIComponent(siteId)}/default-preset`);
  refreshCategories = (siteId: string, profileId: string) =>
    this.json<{ health: ProfileHealth; categories: Category[] }>('POST', `/sites/${encodeURIComponent(siteId)}/categories/refresh`, { profileId });

  profiles = () => this.json<ProfileView[]>('GET', '/profiles');
  createProfile = (req: ProfileCreate) => this.json<{ id: string }>('POST', '/profiles', req);
  patchProfile = (id: string, patch: ProfilePatch) => this.json<{ id: string }>('PATCH', `/profiles/${seg(id)}`, patch);
  deleteProfile = (id: string) => this.json<void>('DELETE', `/profiles/${seg(id)}`);
  backupProfile = (id: string) => this.json<{ path: string }>('POST', `/profiles/${seg(id)}/backup`);
  inspectProfile = (id: string) => this.json<ProfileHealth>('POST', `/profiles/${seg(id)}/inspect`);

  logins = () => this.json<LoginView[]>('GET', '/logins');
  login = (id: string) => this.json<LoginView>('POST', `/profiles/${seg(id)}/login`);
  loginAction = (id: string, action: 'recheck' | 'continue' | 'close') => this.json<LoginView>('POST', `/profiles/${seg(id)}/login/${action}`);

  presets = () => this.json<StoredPreset[]>('GET', '/presets');
  savePreset = (preset: StoredPreset) => this.json<StoredPreset>('PUT', `/presets/${encodeURIComponent(preset.id)}`, { preset });
  deletePreset = (id: string) => this.json<void>('DELETE', `/presets/${encodeURIComponent(id)}`);

  activeRuns = () => this.json<ActiveRun[]>('GET', '/runs/active');
  startRun = (presetId: string) => this.json<ActiveRun>('POST', '/runs', { presetId });
  stopRun = (runId: string) => this.json<ActiveRun>('POST', `/runs/${encodeURIComponent(runId)}/stop`);
  history = (limit = 100) => this.json<RunRecord[]>('GET', `/runs/history?limit=${limit}`);
  runEvents = (runId: string) => this.json<LoggedEvent[]>('GET', `/runs/${encodeURIComponent(runId)}/events`);
  runLog = async (runId: string, types: string[]) =>
    (await this.raw('GET', `/runs/${encodeURIComponent(runId)}/log${types.length ? `?types=${types.join(',')}` : ''}`)).text();

  settings = () => this.json<Settings>('GET', '/settings');
  saveSettings = (patch: Partial<Settings>) => this.json<Settings>('PUT', '/settings', patch);
  rotateToken = () => this.json<{ token: string }>('POST', '/token/rotate');
  updateCheck = () => this.json<UpdateInfo>('GET', '/update-check');

  schedules = () => this.json<ScheduleList>('GET', '/schedules');
  saveSchedule = (spec: ScheduleSpec) => this.json<ScheduleList>('PUT', `/schedules/${encodeURIComponent(spec.id)}`, spec);
  deleteSchedule = (id: string) => this.json<ScheduleList>('DELETE', `/schedules/${encodeURIComponent(id)}`);
  triggerSchedule = (id: string) => this.json<{ runId: string }>('POST', `/schedules/${encodeURIComponent(id)}/trigger`);
  pauseSchedule = (id: string) => this.json<ScheduleList>('POST', `/schedules/${encodeURIComponent(id)}/pause`);
  resumeSchedule = (id: string) => this.json<ScheduleList>('POST', `/schedules/${encodeURIComponent(id)}/resume`);
  scheduleHistory = (id: string) => this.json<ScheduleHistoryEntry[]>('GET', `/schedules/${encodeURIComponent(id)}/history`);
}

/** `server-closed`: the server shut down on purpose (close code 1001); reconnecting would only fail. */
export type StreamStatus = 'connecting' | 'open' | 'closed' | 'auth-failed' | 'server-closed';

/**
 * The `/events` socket: the first frame authenticates; afterwards frames arrive until the socket
 * drops, and it reconnects with a growing delay. A rejected token stops reconnecting.
 */
export class EventStream {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly api: Api,
    private readonly onFrame: (f: ServerFrame) => void,
    private readonly onStatus: (s: StreamStatus) => void,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  /** After a token rotation the server drops every socket; this reconnects with the new token at once. */
  reconnectNow() {
    this.retry = 0;
    this.ws?.close();
  }

  private connect() {
    this.onStatus('connecting');
    const ws = new WebSocket(`${this.api.baseUrl.replace(/^http/, 'ws')}/events`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.api.currentToken }));
    ws.onmessage = (m) => {
      const frame = JSON.parse(String(m.data)) as ServerFrame;
      if (frame.type === 'auth-ok') {
        this.retry = 0;
        this.onStatus('open');
      }
      this.onFrame(frame);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4401) {
        this.onStatus('auth-failed');
        return;
      }
      if (e.code === 1001) {
        this.onStatus('server-closed');
        return;
      }
      this.onStatus('closed');
      if (this.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}
