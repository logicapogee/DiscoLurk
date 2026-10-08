import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Command } from '@tauri-apps/plugin-shell';

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  version: string;
}

export class SidecarStartError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

const OUTPUT_LIMIT = 200;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Dynamic/private range, so the port never collides with a well-known service. */
const randomPort = () => 49152 + Math.floor(Math.random() * (65535 - 49152));

/**
 * §10.4 start-up: a fresh token and port on every launch and the sidecar spawned as externalBin with
 * exactly the argument shape the capability allows. The shell then polls /health for up to 10 s and
 * shows the window whatever the outcome.
 */
export async function launchSidecar(): Promise<SidecarConnection> {
  const token = newToken();
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const keep = (line: string) => {
    output.push(line);
    if (output.length > OUTPUT_LIMIT) output.shift();
  };
  let exited: string | null = null;

  const command = Command.sidecar('binaries/lurk', ['sidecar', '--port', String(port), '--token', token]);
  command.stdout.on('data', (line) => keep(line));
  command.stderr.on('data', (line) => keep(line));
  command.on('close', (e) => (exited = `sidecar exited with code ${String(e.code)}, signal ${String(e.signal)}`));
  command.on('error', (e) => keep(`error: ${e}`));
  await command.spawn();

  try {
    const health = JSON.parse(await invoke<string>('await_sidecar', { port })) as { version: string };
    return { baseUrl, token, version: health.version };
  } catch (err) {
    throw new SidecarStartError(exited ?? String(err), output.join('\n'));
  }
}

export async function fetchDoctor(conn: SidecarConnection): Promise<DoctorReport> {
  const res = await fetch(`${conn.baseUrl}/doctor`, { headers: { Authorization: `Bearer ${conn.token}` } });
  if (!res.ok) throw new Error(`/doctor returned HTTP ${res.status}`);
  return (await res.json()) as DoctorReport;
}

export function showWindow(): Promise<void> {
  return getCurrentWindow().show();
}

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
