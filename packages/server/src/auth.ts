import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@disco-lurk/core';

export const MIN_TOKEN_BYTES = 32;
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 forms as Node reports them. */
export function isLoopback(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return v4.startsWith('127.') || ip === '::1';
}

/** A crude entropy floor: a long token built from a handful of characters (`aaaa…`, `1212…`) is still guessable. */
const MIN_TOKEN_DISTINCT_CHARS = 16;

export function tokenStrongEnough(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') >= MIN_TOKEN_BYTES && new Set(token).size >= MIN_TOKEN_DISTINCT_CHARS;
}

export const TOKEN_REQUIREMENT = `at least ${MIN_TOKEN_BYTES} bytes with at least ${MIN_TOKEN_DISTINCT_CHARS} different characters`;

const bare = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/**
 * The address failures are counted against. Behind a trusted reverse proxy every request comes
 * from the proxy, so the client is the rightmost `X-Forwarded-For` entry the proxies did not add.
 */
export function clientAddress(remote: string, forwardedFor: string | string[] | undefined, trustedProxies: readonly string[]): string {
  const trusted = new Set(trustedProxies.map(bare));
  if (!trusted.has(bare(remote)) || forwardedFor === undefined) return remote;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(bare(hops[i]!))) return hops[i]!;
  return remote;
}

/**
 * Bearer token check plus per-source lockout after 5 failures in 10 minutes, for 15 minutes; the
 * fifth failure still answers as a plain denial and the lockout shows from the next request on.
 * Sources that are never counted, and whose failures the server slows down instead:
 * - loopback, since every local process shares 127.0.0.1 and any of them could lock the desktop UI out;
 * - a source that signed in successfully within the last 10 minutes, so a stale tab retrying an
 *   old token after a rotation cannot lock its own user out.
 */
export class TokenGuard {
  private expected: Buffer;
  private failures = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();
  private lastSuccess = new Map<string, number>();

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

  /** Failures from this source are delayed by the server rather than counted toward a lockout. */
  exempt(ip: string): boolean {
    if (isLoopback(ip)) return true;
    const at = this.lastSuccess.get(ip);
    return at !== undefined && this.clock.now() - at < FAILURE_WINDOW_MS;
  }

  check(ip: string, presented: string | undefined): 'ok' | 'denied' | 'locked' {
    if (this.isLocked(ip)) return 'locked';
    const now = this.clock.now();
    if (this.matches(presented)) {
      this.failures.delete(ip);
      this.lastSuccess.set(ip, now);
      return 'ok';
    }
    if (this.exempt(ip)) return 'denied';
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    recent.push(now);
    if (recent.length >= MAX_FAILURES) {
      this.failures.delete(ip);
      this.lockedUntil.set(ip, now + LOCKOUT_MS);
      this.onLockout(ip);
      return 'denied';
    }
    this.failures.set(ip, recent);
    return 'denied';
  }
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return m?.[1];
}
