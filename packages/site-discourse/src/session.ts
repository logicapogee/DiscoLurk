import type { Page, Request } from 'playwright-core';
import { pauseWithin, RunError, untilAbort, type BrowserChannel, type ForumSession, type RuntimeDeps, type Site, type TimingsReceipt } from '@disco-lurk/core';
import type { Composer, LikeButton } from './actions';
import { launchProfile, type BrowserSession } from './browser';
import { DiscourseForum, titleLinkSelector, type Credentials, type LoginForm, type TitleLinks } from './forum';
import { PAGE_TIMEOUTS, PageView, TargetWatch, targetClosed } from './page';
import { parseTimingsBody } from './parse';
import { COMPOSER_DISCARD, COMPOSER_DISCARD_CONFIRM, EDITOR_SELECTORS, likeButtonOf, SELECTORS } from './selectors';

interface OpenForumOptions {
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
function composer(page: Page, call: PageCall, postsAcknowledged: () => number): Composer {
  const timeout = PAGE_TIMEOUTS.actionMs;
  return {
    postsAcknowledged,
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

/** The address the composer posts a new reply to. */
const postsUrlOf = (site: Pick<Site, 'baseUrl'>) => `${new URL(site.baseUrl).origin}/posts`;

type FinishedRequest = Pick<Request, 'url' | 'method' | 'postData' | 'response'>;

/**
 * Whether a finished request was a `POST` to `endpoint` (query string allowed) that the site answered
 * with success. It runs for every request the page makes, so the address is compared as a string
 * before anything else is looked at.
 */
export async function acknowledgedPost(endpoint: string, request: FinishedRequest): Promise<boolean> {
  const url = request.url();
  if (!url.startsWith(endpoint)) return false;
  const rest = url.slice(endpoint.length);
  if ((rest !== '' && !rest.startsWith('?')) || request.method() !== 'POST') return false;
  return (await request.response())?.ok() ?? false;
}

/** The read receipt of a finished request when it was an acknowledged `POST` to `timingsUrl`; null for any other request. */
export async function timingsReceipt(timingsUrl: string, request: FinishedRequest): Promise<TimingsReceipt | null> {
  return (await acknowledgedPost(timingsUrl, request)) ? parseTimingsBody(request.postData()) : null;
}

/**
 * Follows the page's finished requests: acknowledged read receipts go to `onTimings`, acknowledged
 * new posts are counted. A request whose response can no longer be read because the page closed
 * proves nothing; any other failure to read one is reported as a warning.
 */
export function watchSiteRequests(
  page: Pick<Page, 'on'>,
  site: Pick<Site, 'baseUrl'>,
  opts: { onTimings?: (receipt: TimingsReceipt) => void; warn: (code: string, message: string) => void },
): { postsAcknowledged(): number } {
  const timingsUrl = timingsUrlOf(site);
  const postsUrl = postsUrlOf(site);
  let posts = 0;
  const failed = (err: unknown) => {
    if (!targetClosed(err)) opts.warn('request-unreadable', `A finished request could not be read: ${err instanceof Error ? err.message : String(err)}`);
  };
  page.on('requestfinished', (request) => {
    const { onTimings } = opts;
    if (onTimings) timingsReceipt(timingsUrl, request).then((receipt) => receipt && onTimings(receipt), failed);
    acknowledgedPost(postsUrl, request).then((ok) => {
      if (ok) posts++;
    }, failed);
  });
  return { postsAcknowledged: () => posts };
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

/** A person's pause between filling one login field and the next. */
const BETWEEN_FIELDS = { minSec: 0.5, maxSec: 1 };

export function loginForm(page: Pick<Page, 'locator'>, deps: RuntimeDeps, call: PageCall): LoginForm {
  const pause = (signal: AbortSignal) => pauseWithin(deps, BETWEEN_FIELDS, signal);
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
  const warn = opts.warn ?? (() => {});
  const requests = watchSiteRequests(browser.page, opts.site, { ...(opts.onTimings ? { onTimings: opts.onTimings } : {}), warn });
  const call = watch.call;
  const session = browser;
  // Closing a browser the user already closed must still release the Profile lock.
  const close = () =>
    session.close().catch((err: unknown) => {
      if (!targetClosed(err)) throw err;
    });
  const page = new PageView(browser.page, watch);
  const forum = new DiscourseForum({
    site: opts.site,
    page,
    titleLinks: titleLinks(browser.page, call),
    likeButton: likeButton(browser.page, call),
    composer: composer(browser.page, call, requests.postsAcknowledged),
    replyTemplates: opts.replyTemplates ?? [],
    deps: opts.deps,
    headless: opts.headless,
    ...(opts.credentials ? { login: { credentials: opts.credentials, form: loginForm(browser.page, opts.deps, call) } } : {}),
    warn,
  });
  return { forum, closed: watch.closed.signal, close };
}
