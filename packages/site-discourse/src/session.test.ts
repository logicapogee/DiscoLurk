import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { loginForm } from './session';

describe('B10 login form', () => {
  it('a stop request ends a submit whose page call hangs, without waiting for its timeout', async () => {
    const time = new VirtualTime();
    const hanging = { locator: () => ({ fill: () => new Promise<void>(() => {}), click: async () => {} }) } as unknown as Pick<Page, 'locator'>;
    const form = loginForm(hanging, time.deps(), (fn) => fn());
    const stop = new AbortController();
    time.at(1_000, () => stop.abort());
    await expect(time.drive(form.submit({ username: 'u', password: 'p' }, stop.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(time.clock.monotonic()).toBe(1_000);
  });

  it('names a timed-out step page-timeout, by step and error class only', async () => {
    const time = new VirtualTime();
    const slow = {
      locator: () => ({
        fill: async () => {},
        click: async () => {
          throw Object.assign(new Error('locator.click: Timeout 10000ms exceeded.'), { name: 'TimeoutError' });
        },
      }),
    } as unknown as Pick<Page, 'locator'>;
    const form = loginForm(slow, time.deps(), (fn) => fn());
    await expect(time.drive(form.submit({ username: 'u', password: 'p' }, new AbortController().signal))).rejects.toMatchObject({
      code: 'page-timeout',
      message: 'submit failed: TimeoutError',
    });
  });
});
