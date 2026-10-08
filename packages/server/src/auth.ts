import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@disco-lurk/core';

export const MIN_TOKEN_BYTES = 32;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

export function tokenStrongEnough(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') >= MIN_TOKEN_BYTES;
}

/** §10.3: bearer token check plus per-IP lockout after 5 failures in 10 minutes, for 15 minutes. */
export class TokenGuard {
  private expected: Buffer;
  private failures = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();

  constructor(
    token: string,
    private readonly clock: Clock,
    private readonly onLockout: (ip: string) => void = () => {},
  ) {
    this.expected = digest(token);
  }

  rotate(token: string): void {
    this.expected = digest(token);
  }

  isLocked(ip: string): boolean {
    const until = this.lockedUntil.get(ip);
    if (until === undefined) return false;
    if (this.clock.now() < until) return true;
    this.lockedUntil.delete(ip);
    return false;
  }

  /** Comparing digests keeps the comparison constant-time regardless of the presented length. */
  matches(presented: string | undefined): boolean {
    return presented !== undefined && timingSafeEqual(digest(presented), this.expected);
  }

  check(ip: string, presented: string | undefined): 'ok' | 'denied' | 'locked' {
    if (this.isLocked(ip)) return 'locked';
    if (this.matches(presented)) return 'ok';
    const now = this.clock.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    recent.push(now);
    if (recent.length >= MAX_FAILURES) {
      this.failures.delete(ip);
      this.lockedUntil.set(ip, now + LOCKOUT_MS);
      this.onLockout(ip);
      return 'locked';
    }
    this.failures.set(ip, recent);
    return 'denied';
  }
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return m?.[1];
}
