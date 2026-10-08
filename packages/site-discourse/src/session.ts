import type { Page, Response } from 'playwright-core';
import { pauseBetween, RunError, untilAbort, type BrowserChannel, type ForumSession, type RuntimeDeps, type Site, type TimingsReceipt } from '@disco-lurk/core';
import { launchProfile, type BrowserSession } from './browser';
import { DiscourseForum, titleLinkSelector, type Credentials, type LoginForm, type TitleLinks } from './forum';
import { PAGE_TIMEOUTS, PageView, TargetWatch, targetClosed } from './page';
import { parseTimingsBody } from './parse';
import { SELECTORS } from './selectors';

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
  warn?: (code: string, message: string) => void;
  /** Each `/topics/timings` flush the site answered with success. */
  onTimings?: (receipt: TimingsReceipt) => void;
}


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

/** The read receipt of an acknowledged `POST /topics/timings` on the site; null for any other response. */
export function timingsReceipt(site: Pick<Site, 'baseUrl'>, response: Pick<Response, 'url' | 'ok' | 'request'>): TimingsReceipt | null {
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return null;
  }
  if (url.origin !== new URL(site.baseUrl).origin || url.pathname !== '/topics/timings') return null;
  const request = response.request();
  if (request.method() !== 'POST' || !response.ok()) return null;
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
    browser.page.on('response', (response) => {
      const receipt = timingsReceipt(opts.site, response);
      if (receipt) deliver(receipt);
    });
  }
  const call = watch.call;
  const forum = new DiscourseForum({
    site: opts.site,
    page: new PageView(browser.page, watch),
    titleLinks: titleLinks(browser.page, call),
    deps: opts.deps,
    headless: opts.headless,
    ...(opts.credentials ? { login: { credentials: opts.credentials, form: loginForm(browser.page, opts.deps, call) } } : {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
  });
  const session = browser;
  return {
    forum,
    closed: watch.closed.signal,
    // Closing a browser the user already closed must still release the Profile lock.
    close: () =>
      session.close().catch((err: unknown) => {
        if (!targetClosed(err)) throw err;
      }),
  };
}
