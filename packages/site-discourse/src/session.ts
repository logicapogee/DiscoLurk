import type { Page } from 'playwright-core';
import { randomBetween, RunError, stopRequest, type BrowserChannel, type ForumSession, type RuntimeDeps, type Site } from '@disco-lurk/core';
import { launchProfile, type BrowserSession } from './browser';
import { DiscourseForum, titleLinkSelector, type Credentials, type LoginForm, type TitleLinks } from './forum';
import { closedAsStop, PageView, targetClosed } from './page';
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
}

const LAUNCH_ATTEMPTS = 3;

/**
 * B03: a missing browser, a held Profile lock and permission errors are reported at once; any
 * other launch failure is retried, up to three attempts in all.
 */
function retryable(err: unknown): boolean {
  if (err instanceof RunError) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS';
}

function titleLinks(page: Page, call: ReturnType<typeof closedAsStop>): TitleLinks {
  return { click: (topicId) => call(() => page.locator(titleLinkSelector(topicId)).first().click()) };
}

function loginForm(page: Page, deps: RuntimeDeps, call: ReturnType<typeof closedAsStop>): LoginForm {
  const pause = (signal: AbortSignal) => deps.sleeper.sleep(randomBetween(deps.random, 0.5, 1) * 1000, signal);
  return {
    submit: (credentials, signal) =>
      call(async () => {
        await page.locator(SELECTORS.loginUsername).fill(credentials.username);
        await pause(signal);
        await page.locator(SELECTORS.loginPassword).fill(credentials.password);
        await pause(signal);
        await page.locator(SELECTORS.loginButton).click();
      }),
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
  const closed = new AbortController();
  const onClose = () => closed.abort(stopRequest('browser-closed'));
  browser.context.on('close', onClose);
  browser.page.on('close', onClose);
  const call = closedAsStop(closed);
  const forum = new DiscourseForum({
    site: opts.site,
    page: new PageView(browser.page, closed),
    titleLinks: titleLinks(browser.page, call),
    deps: opts.deps,
    ...(opts.credentials ? { login: { credentials: opts.credentials, form: loginForm(browser.page, opts.deps, call) } } : {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
  });
  const session = browser;
  return {
    forum,
    closed: closed.signal,
    // Closing a browser the user already closed must still release the Profile lock.
    close: () =>
      session.close().catch((err: unknown) => {
        if (!targetClosed(err)) throw err;
      }),
  };
}
