import { describe, expect, it } from 'vitest';
import { clientAddress, isLoopback, TokenGuard, tokenStrongEnough } from './auth';

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
    // The fifth failure is still a plain denial; the lockout shows from the next request on.
    expect(g.check(remote, 'bad')).toBe('denied');
    expect(locked).toEqual([remote]);
    expect(g.check(remote, 'bad')).toBe('locked');
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

  it('delays instead of locking a source that signed in within the last 10 minutes', () => {
    const { g, clock, locked } = guard();
    const remote = '203.0.113.7';
    expect(g.check(remote, TOKEN)).toBe('ok');
    for (let i = 0; i < 20; i++) expect(g.check(remote, 'old-token')).toBe('denied');
    expect(g.exempt(remote)).toBe(true);
    expect(locked).toEqual([]);
    clock.ms += 10 * 60_000;
    expect(g.exempt(remote)).toBe(false);
    for (let i = 0; i < 5; i++) g.check(remote, 'old-token');
    expect(locked).toEqual([remote]);
  });

  it('counts failures behind a trusted proxy against the forwarded client', () => {
    const proxies = ['10.0.0.2', '10.0.0.3'];
    expect(clientAddress('10.0.0.2', '198.51.100.9, 203.0.113.7, 10.0.0.3', proxies)).toBe('203.0.113.7');
    expect(clientAddress('::ffff:10.0.0.2', '203.0.113.7', proxies)).toBe('203.0.113.7');
    // An untrusted peer cannot pick its own key by sending the header.
    expect(clientAddress('192.0.2.1', '203.0.113.7', proxies)).toBe('192.0.2.1');
    expect(clientAddress('10.0.0.2', undefined, proxies)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', '10.0.0.3', proxies)).toBe('10.0.0.2');
  });

  it('requires 32 bytes and some variety in a token', () => {
    expect(tokenStrongEnough('x'.repeat(64))).toBe(false);
    expect(tokenStrongEnough('0123456789abcdef'.repeat(2))).toBe(true);
    expect(tokenStrongEnough('0123456789abcde'.repeat(3))).toBe(false);
    expect(tokenStrongEnough('0123456789abcdefghij')).toBe(false);
  });

  it('treats IPv4-mapped remote addresses as remote', () => {
    expect(isLoopback('::ffff:203.0.113.7')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });
});
