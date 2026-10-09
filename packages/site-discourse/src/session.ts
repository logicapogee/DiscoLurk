import type { Page, Request } from 'playwright-core';
import { pauseBetween, RunError, untilAbort, type BrowserChannel, type ForumSession, type RuntimeDeps, type Site, type TimingsReceipt } from '@disco-lurk/core';
import type { Composer, LikeButton } from './actions';
import { launchProfile, type BrowserSession } from './browser';
import { DiscourseForum, titleLinkSelector, type Credentials, type LoginForm, type TitleLinks } from './forum';
import { PAGE_TIMEOUTS, PageView, TargetWatch, targetClosed } from './page';
import { parseTimingsBody } from './parse';
import { COMPOSER_DISCARD, COMPOSER_DISCARD_CONFIRM, EDITOR_SELECTORS, likeButtonOf, SELECTORS } from './selectors';

export interface OpenForumOptions {
  site: Site;
  profileDir: string;
  runId: string;
  channel: BrowserChannel;
  headless: boolean;
  deps: RuntimeDeps;
  executablePath?: string;
  proxy?: string;
  credentials?: Credentials;
  replyTemplates?: readonly string[];
  warn?: (code: string, message: string) => void;
  /** Each `/topics/timings` flush the site answered with success. */
  onTimings?: (receipt: TimingsReceipt) => void;
}

/** How long the discard confirmation may take to appear before the composer is assumed closed. */
const DISCARD_CONFIRM_MS = 3_000;

const LAUNCH_ATTEMPTS = 3;

/**
 * A missing browser, a held Profile lock and permission errors are reported at once; any
 * other launch failure is retried, up to three attempts in all.
 */
function retryable(err: unknown): boolean {
  if (err instanceof RunError) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS';
}

type PageCall = TargetWatch['call'];

function titleLinks(page: Page, call: PageCall): TitleLinks {
  return { click: (topicId) => call(() => page.locator(titleLinkSelector(topicId)).first().click({ timeout: PAGE_TIMEOUTS.actionMs })) };
}

function likeButton(page: Page, call: PageCall): LikeButton {
  return { click: (postNumber) => call(() => page.locator(likeButtonOf(postNumber)).first().click({ timeout: PAGE_TIMEOUTS.actionMs })) };
}

/** Typing goes through `fill`, which works on a textarea and a contenteditable ProseMirror editor alike. */
function composer(page: Page, call: PageCall): Composer {
  const timeout = PAGE_TIMEOUTS.actionMs;
  return {
    open: () => call(() => page.locator(SELECTORS.replyOpen).first().click({ timeout })),
    fill: (kind, text) => call(() => page.locator(EDITOR_SELECTORS[kind]).first().fill(text, { timeout })),
    submit: () => call(() => page.locator(SELECTORS.replySubmit).first().click({ timeout })),
    discard: () =>
      call(async () => {
        await page.locator(COMPOSER_DISCARD).first().click({ timeout });
        const confirm = page.locator(COMPOSER_DISCARD_CONFIRM).first();
        const asked = await confirm.waitFor({ state: 'visible', timeout: DISCARD_CONFIRM_MS }).then(
          () => true,
          () => false,
        );
        if (asked) await confirm.click({ timeout });
      }),
  };
}

/** The address the site's screen tracker posts its read receipts to. */
export const timingsUrlOf = (site: Pick<Site, 'baseUrl'>) => `${new URL(site.baseUrl).origin}/topics/timings`;

/**
 * The read receipt of a finished request when it was an acknowledged `POST` to `timingsUrl`; null
 * for any other request. It runs for every request the page makes, so the address is compared as a
 * string before anything else is looked at.
 */
export async function timingsReceipt(timingsUrl: string, request: Pick<Request, 'url' | 'method' | 'postData' | 'response'>): Promise<TimingsReceipt | null> {
  const url = request.url();
  if (!url.startsWith(timingsUrl)) return null;
  const rest = url.slice(timingsUrl.length);
  if ((rest !== '' && !rest.startsWith('?')) || request.method() !== 'POST') return null;
  const response = await request.response();
  if (!response?.ok()) return null;
  return parseTimingsBody(request.postData());
}

/**
 * Playwright's messages for a failed fill can quote the value typed, so a failed step is reported
 * by its name and the error's class only; the credentials never reach a message, event or log.
 */
async function loginStep(step: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (targetClosed(err)) throw err;
    const name = err instanceof Error ? err.name : typeof err;
    throw new RunError(name === 'TimeoutError' ? 'page-timeout' : 'needs-auth', `${step} failed: ${name}`);
  }
}

export function loginForm(page: Pick<Page, 'locator'>, deps: RuntimeDeps, call: PageCall): LoginForm {
  const pause = (signal: AbortSignal) => pauseBetween(deps, 0.5, 1, signal);
  const timeout = PAGE_TIMEOUTS.actionMs;
  return {
    submit: (credentials, signal) =>
      untilAbort(
        call(async () => {
          await loginStep('username', () => page.locator(SELECTORS.loginUsername).fill(credentials.username, { timeout }));
          await pause(signal);
          await loginStep('password', () => page.locator(SELECTORS.loginPassword).fill(credentials.password, { timeout }));
          await pause(signal);
          await loginStep('submit', () => page.locator(SELECTORS.loginButton).click({ timeout }));
        }),
        signal,
      ),
  };
}

export async function openDiscourseForum(opts: OpenForumOptions): Promise<ForumSession> {
  let browser: BrowserSession | undefined;
  for (let attempt = 1; !browser; attempt++) {
    try {
      browser = await launchProfile({
        profileDir: opts.profileDir,
        runId: opts.runId,
        channel: opts.channel,
        headless: opts.headless,
        ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
      });
    } catch (err) {
      if (attempt >= LAUNCH_ATTEMPTS || !retryable(err)) throw err;
    }
  }
  const watch = new TargetWatch();
  browser.context.on('close', () => watch.markClosed());
  browser.page.on('close', () => watch.markClosed());
  browser.page.on('crash', () => watch.markCrashed());
  if (opts.onTimings) {
    const deliver = opts.onTimings;
    const timingsUrl = timingsUrlOf(opts.site);
    browser.page.on('requestfinished', (request) => {
      timingsReceipt(timingsUrl, request).then(
        (receipt) => receipt && deliver(receipt),
        // The page closed before its response could be looked up; an unconfirmed flush is not a receipt.
        (err: unknown) => {
          if (!targetClosed(err)) throw err;
        },
      );
    });
  }
  const call = watch.call;
  const session = browser;
  // Closing a browser the user already closed must still release the Profile lock.
  const close = () =>
    session.close().catch((err: unknown) => {
      if (!targetClosed(err)) throw err;
    });
  const page = new PageView(browser.page, watch);
  if (!opts.headless) {
    try {
      await page.trackVisibility();
    } catch (err) {
      await close();
      throw err;
    }
  }
  const forum = new DiscourseForum({
    site: opts.site,
    page,
    titleLinks: titleLinks(browser.page, call),
    likeButton: likeButton(browser.page, call),
    composer: composer(browser.page, call),
    replyTemplates: opts.replyTemplates ?? [],
    deps: opts.deps,
    headless: opts.headless,
    ...(opts.credentials ? { login: { credentials: opts.credentials, form: loginForm(browser.page, opts.deps, call) } } : {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
  });
  return { forum, closed: watch.closed.signal, close };
}
