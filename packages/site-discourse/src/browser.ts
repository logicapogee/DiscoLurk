import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { RunError, type BrowserChannel } from '@disco-lurk/core';
import { acquireProfileLock, type ProfileLock } from './profile-lock';

export interface LaunchOptions {
  profileDir: string;
  runId: string;
  channel: BrowserChannel;
  headless: boolean;
  executablePath?: string;
  proxy?: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lock: ProfileLock;
  /** Closes the browser, then releases the Profile lock. */
  close(): Promise<void>;
}

/** F09: headed windows are 1200 wide and as tall as the screen; headless uses a fixed tall viewport. */
export const HEADED_WIDTH = 1200;
export const HEADLESS_VIEWPORT = { width: 1280, height: 1600 } as const;

/** B07; the browser's own user agent is kept (B08). */
export const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];
export const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

/** B01/B02/B07: one app-owned Profile directory, locked for the lifetime of the browser. */
export async function launchProfile(opts: LaunchOptions): Promise<BrowserSession> {
  await mkdir(opts.profileDir, { recursive: true });
  const lock = await acquireProfileLock(opts.profileDir, opts.runId);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(opts.profileDir, {
      ...(opts.executablePath ? { executablePath: opts.executablePath } : { channel: opts.channel }),
      headless: opts.headless,
      args: opts.headless ? LAUNCH_ARGS : [...LAUNCH_ARGS, `--window-size=${HEADED_WIDTH},1000`],
      ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
      viewport: opts.headless ? HEADLESS_VIEWPORT : null,
      ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}),
    });
  } catch (err) {
    await lock.release();
    const message = String((err as Error).message ?? err);
    if (/is not found at|Chromium distribution .* is not found|executable doesn't exist/i.test(message)) {
      throw new RunError('browser-missing', message.split('\n')[0]!);
    }
    throw err;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  if (!opts.headless) await setWindowSize(page, HEADED_WIDTH);
  return {
    context,
    page,
    lock,
    async close() {
      try {
        await context.close();
      } finally {
        await lock.release();
      }
    },
  };
}

/** Resizes the real window (headed); the page then lays out exactly as a user's window would. */
export async function setWindowSize(page: Page, width: number, height?: number): Promise<{ width: number; height: number }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const h = height ?? (await page.evaluate(() => screen.availHeight));
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height: h } });
    return { width, height: h };
  } finally {
    await cdp.detach().catch(() => {});
  }
}
