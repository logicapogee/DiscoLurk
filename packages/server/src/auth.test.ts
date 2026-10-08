import { describe, expect, it } from 'vitest';
import { isLoopback, TokenGuard } from './auth';

const TOKEN = 'x'.repeat(43);

function guard() {
  const clock = { ms: Date.UTC(2026, 9, 8) };
  const locked: string[] = [];
  const g = new TokenGuard(TOKEN, { now: () => clock.ms, monotonic: () => clock.ms }, (ip) => locked.push(ip));
  return { g, clock, locked };
}

describe('SERVER-001 failure lockout (§10.3)', () => {
  it('locks a remote IP for 15 minutes after 5 failures within 10 minutes, and logs it', () => {
    const { g, clock, locked } = guard();
    const remote = '203.0.113.7';
    for (let i = 0; i < 4; i++) expect(g.check(remote, 'bad')).toBe('denied');
    clock.ms += 11 * 60_000; // older failures fall out of the window
    for (let i = 0; i < 4; i++) expect(g.check(remote, 'bad')).toBe('denied');
    expect(g.check(remote, 'bad')).toBe('locked');
    expect(locked).toEqual([remote]);
    expect(g.check(remote, TOKEN)).toBe('locked');
    expect(g.check('198.51.100.1', TOKEN)).toBe('ok');
    clock.ms += 15 * 60_000 - 1;
    expect(g.check(remote, TOKEN)).toBe('locked');
    clock.ms += 1;
    expect(g.check(remote, TOKEN)).toBe('ok');
  });

  it.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'])('never counts failures from loopback %s', (ip) => {
    const { g, locked } = guard();
    for (let i = 0; i < 50; i++) expect(g.check(ip, 'bad')).toBe('denied');
    expect(g.check(ip, TOKEN)).toBe('ok');
    expect(locked).toEqual([]);
  });

  it('treats IPv4-mapped remote addresses as remote', () => {
    expect(isLoopback('::ffff:203.0.113.7')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });
});
