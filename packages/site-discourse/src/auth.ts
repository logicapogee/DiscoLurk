import { LOGIN_WAIT_MS, systemClock, systemSleeper, type Clock, type InterruptibleSleeper } from '@disco-lurk/core';
import { expectedMiss, type ReadOnlyPage } from './page';
import { SELECTORS } from './selectors';

interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  clock?: Clock;
  sleeper?: InterruptibleSleeper;
  onPoll?: (elapsedMs: number) => void;
}

/** Probes until it answers with a value; resolves null once the ceiling has passed without one. */
export async function pollUntil<T>(opts: PollOptions, probe: () => Promise<T | null>, signal: AbortSignal): Promise<T | null> {
  const clock = opts.clock ?? systemClock;
  const sleeper = opts.sleeper ?? systemSleeper;
  const start = clock.monotonic();
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    const elapsed = clock.monotonic() - start;
    if (elapsed >= opts.timeoutMs) return null;
    opts.onPoll?.(elapsed);
    await sleeper.sleep(Math.min(opts.intervalMs, opts.timeoutMs - elapsed), signal);
  }
}

/** Polls `condition` until it holds; false once the ceiling has passed without it. */
export async function waitUntil(opts: PollOptions, condition: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return (await pollUntil(opts, async () => ((await condition()) ? true : null), signal)) ?? false;
}

interface LoginWaitOptions extends Partial<PollOptions> {
  signal: AbortSignal;
}

/** Interval of the headed login poll; its ceiling is the kernel's `LOGIN_WAIT_MS`. */
export const LOGIN_POLL_MS = 5_000;

/**
 * Watches for `#current-user` without ever reloading, so a captcha, password entry or
 * redirect in progress is left alone. Resolves false at the ceiling.
 */
export async function waitForCurrentUser(page: ReadOnlyPage, opts: LoginWaitOptions): Promise<boolean> {
  const { signal, ...poll } = opts;
  // A navigation in progress destroys the execution context; that poll simply counts as "not yet".
  const present = () =>
    page.count(SELECTORS.currentUser).then(
      (n) => n > 0,
      (err: unknown) => {
        if (expectedMiss(err)) return false;
        throw err;
      },
    );
  return waitUntil({ intervalMs: LOGIN_POLL_MS, timeoutMs: LOGIN_WAIT_MS, ...poll }, present, signal);
}

const ignoreMiss = (err: unknown) => {
  if (!expectedMiss(err)) throw err;
};

/** The username line of the profile header every `/u/<name>/...` page shows. */
const PROFILE_USERNAME = '.user-profile-names .username';

const USER_PATH = /\/u\/([^/?#]+)/;

/** The username in a `/u/<name>` address, which is where `/my/...` pages redirect to. */
export function usernameFromUrl(url: string): string | null {
  const m = USER_PATH.exec(new URL(url).pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The username of the page a `/my/...` address landed on: its `/u/<name>` address, else the profile
 * header's username. The avatar's title is empty on some sites, so it is never read.
 */
export async function usernameOnPage(page: ReadOnlyPage): Promise<string | null> {
  await page.waitForURL(USER_PATH, { timeout: 15_000 }).catch(ignoreMiss);
  const fromUrl = usernameFromUrl(page.url());
  if (fromUrl) return fromUrl;
  await page.waitFor(PROFILE_USERNAME, { state: 'attached', timeout: 5_000 }).catch(ignoreMiss);
  const fromHeader = (await page.text(PROFILE_USERNAME))?.replace(/^@/, '').trim();
  return fromHeader || null;
}

/** Opens `/my/activity`, which redirects to the signed-in user's own `/u/<name>/activity`. */
export async function readUsername(page: ReadOnlyPage, baseUrl: string): Promise<string | null> {
  await page.goto(new URL('/my/activity', baseUrl).href);
  return usernameOnPage(page);
}
