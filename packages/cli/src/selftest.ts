import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { BrowserChannel } from '@disco-lurk/core';

interface BrowserSelftestOptions {
  url: string;
  profileDir: string;
  screenshot: string;
  channel: BrowserChannel;
  headed: boolean;
}

interface BrowserSelftestResult {
  ok: boolean;
  browserVersion: string;
  userAgent: string;
  webdriver: boolean;
  clickedTo: string;
  /** The marker an earlier run left in this Profile, proving the Profile persisted. */
  previousMarker: string | null;
  marker: string;
  screenshot: string;
}

/**
 * The packaging gate as seen from inside the binary: system Chrome, a persistent context on
 * an app-owned Profile, one locator click on a local page, a screenshot, and a clean close.
 * Launch flags match production; no user agent override.
 */
export async function browserSelftest(opts: BrowserSelftestOptions): Promise<BrowserSelftestResult> {
  await mkdir(opts.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(opts.profileDir, {
    channel: opts.channel,
    headless: !opts.headed,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: opts.headed ? null : { width: 1280, height: 1600 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    const previousMarker = await page.evaluate(() => localStorage.getItem('lurk-gate-marker'));
    const marker = `${Date.now()}-${process.pid}`;
    await page.evaluate((m) => localStorage.setItem('lurk-gate-marker', m), marker);
    await page.locator('a#gate-target').click();
    await page.waitForURL(/\/landing\.html$/, { timeout: 10_000 });
    await page.locator('#landed').waitFor({ state: 'visible', timeout: 10_000 });
    const [userAgent, webdriver] = await page.evaluate(() => [navigator.userAgent, navigator.webdriver] as const);
    await page.screenshot({ path: opts.screenshot, fullPage: false });
    return {
      ok: true,
      browserVersion: /Chrome\/(\S+)/.exec(userAgent)?.[1] ?? 'unknown',
      userAgent,
      webdriver,
      clickedTo: page.url(),
      previousMarker,
      marker,
      screenshot: opts.screenshot,
    };
  } finally {
    await context.close();
  }
}
