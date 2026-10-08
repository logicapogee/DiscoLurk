import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  version: string;
  /** Where the shell writes the sidecar's output. */
  logPath: string;
  /** Whether this build can install updates itself (Windows and Linux; never macOS). */
  updater: boolean;
}

export class SidecarStartError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly logPath: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'disco-lurk-token';

/**
 * Native entry points exist only inside the Tauri shell. A remote browser hides them and signs in
 * with a token the user types, which stays in this tab's session storage only.
 */
export interface Platform {
  desktop: boolean;
  connect(): Promise<SidecarConnection>;
  onRestarted(fn: (conn: SidecarConnection) => void): void;
  autostart: { get(): Promise<boolean>; set(on: boolean): Promise<void> } | null;
  installUpdate(): Promise<void>;
  storedToken(): string | null;
  storeToken(token: string | null): void;
}

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // storage may be unavailable (private mode); the token then lasts only for this page
  }
}

const desktop: Platform = {
  desktop: true,
  async connect() {
    try {
      return await invoke<SidecarConnection>('connect_sidecar');
    } catch (err) {
      const f = err as { message?: string; output?: string; logPath?: string };
      throw new SidecarStartError(f.message ?? String(err), f.output ?? '', f.logPath ?? '');
    }
  },
  onRestarted(fn) {
    void listen<SidecarConnection>('sidecar-restarted', (e) => fn(e.payload));
  },
  autostart: { get: () => isEnabled(), set: (on) => (on ? enable() : disable()) },
  installUpdate: () => invoke('install_update'),
  storedToken: () => null,
  storeToken: () => {},
};

const browser: Platform = {
  desktop: false,
  connect: () => Promise.reject(new Error('not in the desktop shell')),
  onRestarted: () => {},
  autostart: null,
  installUpdate: () => Promise.reject(new Error('not in the desktop shell')),
  storedToken: () => sessionGet(TOKEN_KEY),
  storeToken: (t) => sessionSet(TOKEN_KEY, t),
};

export const platform: Platform = isTauri() ? desktop : browser;
