import type { Page } from 'playwright-core';
import { systemClock, systemSleeper, type Clock, type InterruptibleSleeper } from '@disco-lurk/core';
import { SELECTORS } from './selectors';

export interface LoginWaitOptions {
  signal: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  clock?: Clock;
  sleeper?: InterruptibleSleeper;
  onPoll?: (elapsedMs: number) => void;
}

/** B04: interval and ceiling of the headed login poll. */
export const LOGIN_POLL_MS = 5_000;
export const LOGIN_TIMEOUT_MS = 300_000;

/**
 * B04: watches for `#current-user` without ever reloading, so a captcha, password entry or
 * redirect in progress is left alone. Resolves false at the ceiling.
 */
export async function waitForCurrentUser(page: Page, opts: LoginWaitOptions): Promise<boolean> {
  const clock = opts.clock ?? systemClock;
  const sleeper = opts.sleeper ?? systemSleeper;
  const interval = opts.intervalMs ?? LOGIN_POLL_MS;
  const ceiling = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const start = clock.monotonic();
  for (;;) {
    // A navigation in progress destroys the execution context; that poll simply counts as "not yet".
    const present = await page.locator(SELECTORS.currentUser).count().then((n) => n > 0, () => false);
    if (present) return true;
    const elapsed = clock.monotonic() - start;
    if (elapsed >= ceiling) return false;
    opts.onPoll?.(elapsed);
    await sleeper.sleep(Math.min(interval, ceiling - elapsed), opts.signal);
  }
}

/** B04: the username comes from where `/my/...` redirects, never from the avatar's title. */
export async function readUsername(page: Page, baseUrl: string): Promise<string | null> {
  await page.goto(new URL('/my/activity', baseUrl).href, { waitUntil: 'domcontentloaded' });
  const userPath = /\/u\/([^/?#]+)/;
  await page.waitForURL(userPath, { timeout: 15_000 }).catch(() => {});
  const m = userPath.exec(new URL(page.url()).pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}
