import { invoke } from '@tauri-apps/api/core';

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

/**
 * §10.4: the shell spawns the sidecar, reads its ready line, waits for /health and shows the
 * window; the page only asks for the resulting connection, token included.
 */
export async function connectSidecar(): Promise<SidecarConnection> {
  try {
    return await invoke<SidecarConnection>('connect_sidecar');
  } catch (err) {
    const failure = err as { message?: string; output?: string };
    throw new SidecarStartError(failure.message ?? String(err), failure.output ?? '');
  }
}

export async function fetchDoctor(conn: SidecarConnection): Promise<DoctorReport> {
  const res = await fetch(`${conn.baseUrl}/doctor`, { headers: { Authorization: `Bearer ${conn.token}` } });
  if (!res.ok) throw new Error(`/doctor returned HTTP ${res.status}`);
  return (await res.json()) as DoctorReport;
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
