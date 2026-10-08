import type { Page } from 'playwright-core';
import { abortError, RunError, stopRequest } from '@disco-lurk/core';

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

/** Playwright's error for a call on a page, context or browser that has gone away or crashed. */
export function targetClosed(err: unknown): boolean {
  return err instanceof Error && err.name === 'TargetClosedError';
}

/** Explicit ceilings for every page call that can wait, so none falls back to Playwright's 30 s default unseen. */
export const PAGE_TIMEOUTS = {
  navigationMs: 30_000,
  actionMs: 10_000,
  /** How long a `TargetClosedError` waits for the `close` or `crash` event that explains it. */
  goneEventMs: 2_000,
} as const;

/**
 * Tells why page calls fail with `TargetClosedError`. A window the user closed and a crashed
 * renderer raise the same error, so the page's `close` and `crash` events decide: a close is the
 * session's `browser-closed` stop request, a crash is an internal failure. Playwright may reject an
 * in-flight call before either event arrives, so an unexplained error waits briefly for one.
 */
export class TargetWatch {
  readonly closed = new AbortController();
  private gone: 'closed' | 'crashed' | null = null;
  private readonly waiters = new Set<() => void>();

  markClosed(): void {
    if (this.gone) return;
    this.gone = 'closed';
    this.closed.abort(stopRequest('browser-closed'));
    this.wake();
  }

  markCrashed(): void {
    if (this.gone) return;
    this.gone = 'crashed';
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  private settle(ms: number): Promise<'closed' | 'crashed' | null> {
    if (this.gone) return Promise.resolve(this.gone);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.gone);
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** Runs a page call and turns a `TargetClosedError` into the stop request or failure behind it. */
  readonly call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!targetClosed(err)) throw err;
      const gone = await this.settle(PAGE_TIMEOUTS.goneEventMs);
      if (gone === 'crashed') throw new RunError('internal', 'page crashed');
      if (gone === 'closed') throw abortError(this.closed.signal);
      throw err;
    }
  };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export class PageView implements ReadOnlyPage {
  private readonly call: <T>(fn: () => Promise<T>) => Promise<T>;

  /** Without a `watch`, Playwright's errors pass through unchanged. */
  constructor(
    private readonly page: Page,
    watch?: TargetWatch,
  ) {
    this.call = watch ? watch.call : (fn) => fn();
  }

  goto(url: string, waitUntil: LoadState = 'domcontentloaded'): Promise<void> {
    return this.call(async () => void (await this.page.goto(url, { waitUntil, timeout: PAGE_TIMEOUTS.navigationMs })));
  }

  reload(waitUntil: LoadState = 'domcontentloaded'): Promise<void> {
    return this.call(async () => void (await this.page.reload({ waitUntil, timeout: PAGE_TIMEOUTS.navigationMs })));
  }

  goBack(waitUntil: LoadState = 'commit'): Promise<void> {
    return this.call(async () => void (await this.page.goBack({ waitUntil, timeout: PAGE_TIMEOUTS.navigationMs })));
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
    return this.call(() => this.page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: PAGE_TIMEOUTS.actionMs }));
  }

  moveMouse(x: number, y: number): Promise<void> {
    return this.call(() => this.page.mouse.move(x, y));
  }

  wheel(dx: number, dy: number): Promise<void> {
    return this.call(() => this.page.mouse.wheel(dx, dy));
  }
}
