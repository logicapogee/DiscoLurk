import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** EPERM means the process exists but belongs to someone else, which still makes it alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who wrote a lock file: enough to tell a live owner from a recycled PID or another host. */
export interface LockOwner {
  pid: number;
  hostname?: string;
  /** Epoch ms the owning process started, as `processStartTime` reads it. */
  processStartedAt?: number;
}

/** Start times read two ways (ps rounding, /proc ticks, boot time in whole seconds) differ by this much at most. */
const START_TOLERANCE_MS = 5_000;
/** USER_HZ: the unit of /proc/<pid>/stat's starttime on every mainstream Linux build. */
const LINUX_TICKS_PER_SECOND = 100;

async function linuxStartTime(pid: number): Promise<number | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // The command name may contain spaces and parentheses; the fields after its closing one are fixed.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]);
  const btime = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'));
  if (!Number.isFinite(ticks) || !btime) return null;
  return (Number(btime[1]) + ticks / LINUX_TICKS_PER_SECOND) * 1000;
}

async function psStartTime(pid: number): Promise<number | null> {
  const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } });
  const ms = Date.parse(stdout.trim().replace(/\s+/g, ' '));
  return Number.isNaN(ms) ? null : ms;
}

async function windowsStartTime(pid: number): Promise<number | null> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
  ]);
  const ms = Date.parse(stdout.trim());
  return Number.isNaN(ms) ? null : ms;
}

/** When a process started, in epoch ms; null when the platform cannot say or the process is gone. */
export async function processStartTime(pid: number, platform = process.platform): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') return await linuxStartTime(pid);
    if (platform === 'win32') return await windowsStartTime(pid);
    return await psStartTime(pid);
  } catch {
    return null;
  }
}

let self: Promise<LockOwner> | null = null;

/** This process as a lock owner; its start time is read the same way a later checker will read it. */
export function currentLockOwner(): Promise<LockOwner> {
  self ??= processStartTime(process.pid).then((read) => ({
    pid: process.pid,
    hostname: hostname(),
    processStartedAt: read ?? Math.round(Date.now() - process.uptime() * 1000),
  }));
  return self;
}

/** Lock files this process holds right now, by path. */
const heldHere = new Set<string>();

export function markLockHeld(path: string): void {
  heldHere.add(path);
}

export function markLockReleased(path: string): void {
  heldHere.delete(path);
}

export interface LivenessProbe {
  isAlive?: (pid: number) => boolean;
  startTime?: (pid: number) => Promise<number | null>;
  host?: string;
}

/**
 * Whether the owner recorded in the lock at `path` still holds it. A container restarts its
 * entrypoint under the same PID, so a lock naming this process counts only while this process
 * holds it; a lock from another host, or from a process whose start time differs (a recycled
 * PID), is stale.
 */
export async function lockOwnerLive(owner: LockOwner, path: string, probe: LivenessProbe = {}): Promise<boolean> {
  if (owner.hostname !== undefined && owner.hostname !== (probe.host ?? hostname())) return false;
  if (owner.pid === process.pid) return heldHere.has(path);
  if (!(probe.isAlive ?? processAlive)(owner.pid)) return false;
  if (owner.processStartedAt === undefined) return true;
  const actual = await (probe.startTime ?? processStartTime)(owner.pid);
  return actual === null || Math.abs(actual - owner.processStartedAt) <= START_TOLERANCE_MS;
}
