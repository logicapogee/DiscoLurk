import type { Page } from 'playwright-core';
import { abortError, stopRequest } from '@disco-lurk/core';

export type LoadState = 'domcontentloaded' | 'commit';

export interface WaitOptions {
  timeout: number;
  state?: 'attached' | 'visible';
}

/**
 * What the adapter may do with a site page: navigate, look, scroll and resize. Nothing here can
 * type into, click on or run script in the page; the two inputs a run may send are separate
 * narrow capabilities (`TitleLinks`, `LoginForm`) built by session.ts.
 */
export interface ReadOnlyPage {
  goto(url: string, waitUntil?: LoadState): Promise<void>;
  reload(waitUntil?: LoadState): Promise<void>;
  goBack(waitUntil?: LoadState): Promise<void>;
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  /** The layout viewport; a headed window has no fixed viewport, so its inner size is read. */
  viewportSize(): Promise<{ width: number; height: number }>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  /** The serialized DOM, for the parsers in parse.ts and progress/. */
  content(): Promise<string>;
  count(selector: string): Promise<number>;
  /** Whitespace-collapsed text of the first match; null when nothing matches. */
  text(selector: string): Promise<string | null>;
  texts(selector: string): Promise<string[]>;
  waitFor(selector: string, opts: WaitOptions): Promise<void>;
  waitForURL(url: RegExp, opts: { timeout: number }): Promise<void>;
  scrollIntoView(selector: string): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  wheel(dx: number, dy: number): Promise<void>;
}

/**
 * Page reads that may come up empty without anything being wrong: a wait that ran out, or a query
 * that raced a navigation and lost its execution context. Everything else is a real failure.
 */
export function expectedMiss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.message.includes('Execution context was destroyed');
}

/** Playwright's error for a call on a page, context or browser that has gone away. */
export function targetClosed(err: unknown): boolean {
  return err instanceof Error && err.name === 'TargetClosedError';
}

/**
 * Runs page calls so that a browser closed from outside surfaces as the session's stop request,
 * also when Playwright rejects an in-flight call before the page's `close` event fires.
 */
export function closedAsStop(closed: AbortController | undefined): <T>(call: () => Promise<T>) => Promise<T> {
  return async (call) => {
    try {
      return await call();
    } catch (err) {
      if (!closed || !targetClosed(err)) throw err;
      closed.abort(stopRequest('browser-closed'));
      throw abortError(closed.signal);
    }
  };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export class PageView implements ReadOnlyPage {
  private readonly call: <T>(fn: () => Promise<T>) => Promise<T>;

  /** `closed` is the session's browser-closed controller; without one, Playwright's errors pass through. */
  constructor(
    private readonly page: Page,
    closed?: AbortController,
  ) {
    this.call = closedAsStop(closed);
  }

  goto(url: string, waitUntil: LoadState = 'domcontentloaded'): Promise<void> {
    return this.call(async () => void (await this.page.goto(url, { waitUntil })));
  }

  reload(waitUntil: LoadState = 'domcontentloaded'): Promise<void> {
    return this.call(async () => void (await this.page.reload({ waitUntil })));
  }

  goBack(waitUntil: LoadState = 'commit'): Promise<void> {
    return this.call(async () => void (await this.page.goBack({ waitUntil })));
  }

  url(): string {
    return this.page.url();
  }

  title(): Promise<string> {
    return this.call(() => this.page.title());
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  viewportSize(): Promise<{ width: number; height: number }> {
    const fixed = this.page.viewportSize();
    if (fixed) return Promise.resolve(fixed);
    return this.call(() => this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  }

  setViewportSize(size: { width: number; height: number }): Promise<void> {
    return this.call(() => this.page.setViewportSize(size));
  }

  content(): Promise<string> {
    return this.call(() => this.page.content());
  }

  count(selector: string): Promise<number> {
    return this.call(() => this.page.locator(selector).count());
  }

  async text(selector: string): Promise<string | null> {
    return (await this.texts(selector))[0] ?? null;
  }

  texts(selector: string): Promise<string[]> {
    return this.call(async () => (await this.page.locator(selector).allTextContents()).map(squash));
  }

  waitFor(selector: string, opts: WaitOptions): Promise<void> {
    return this.call(() => this.page.locator(selector).first().waitFor({ state: opts.state ?? 'attached', timeout: opts.timeout }));
  }

  waitForURL(url: RegExp, opts: { timeout: number }): Promise<void> {
    return this.call(() => this.page.waitForURL(url, { timeout: opts.timeout }));
  }

  scrollIntoView(selector: string): Promise<void> {
    return this.call(() => this.page.locator(selector).first().scrollIntoViewIfNeeded());
  }

  moveMouse(x: number, y: number): Promise<void> {
    return this.call(() => this.page.mouse.move(x, y));
  }

  wheel(dx: number, dy: number): Promise<void> {
    return this.call(() => this.page.mouse.wheel(dx, dy));
  }
}
