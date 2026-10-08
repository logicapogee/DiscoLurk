import type { Locator, Page } from 'playwright-core';
import {
  abortError,
  randomBetween,
  RunError,
  throwIfAborted,
  type ActionPolicy,
  type ActionResult,
  type AuthMode,
  type AuthResult,
  type BrowseMode,
  type Category,
  type ErrorCode,
  type ForumPort,
  type LevelSnapshot,
  type ReadResult,
  type ReadStrategy,
  type ReadVerification,
  type RunFailure,
  type RuntimeDeps,
  type Site,
  type TopicBatch,
  type TopicCandidate,
  type TopicStrategy,
  type TopicVisit,
} from '@disco-lurk/core';
import { waitForCurrentUser } from './auth';
import { categoryLinks, parseDocument, parseFloorCounter, parseTopicList, type CategoryLink } from './parse';
import { parseConnect } from './progress/connect-linuxdo';
import { progressModuleFor } from './progress/index';
import { parseTrustLevel, TRUST_LEVEL_SELECTORS } from './progress/trust-level-docofcard';
import { readFloors, type FloorSurface } from './reading';
import {
  ANONYMOUS_HEADER,
  CHALLENGE_SELECTOR,
  CHALLENGE_TITLE,
  CONNECT_READY,
  rowSelector,
  SELECTORS,
  SORTED_BY_POSTS_QUERY,
  topicUrlPattern,
} from './selectors';

/** Page-load ceilings (I8); reading pace lives in reading.ts and is not shortened by fast pages. */
const LIST_WAIT_MS = 20_000;
const ENTER_URL_MS = 15_000;
const ENTER_CONTENT_MS = 10_000;
const RETURN_ROW_MS = 15_000;
const SIGN_IN_CHECK_MS = 20_000;
const PROGRESS_READY_MS = 20_000;
/** S07 */
const TRUST_LEVEL_READY_MS = 10_000;
const CONNECT_SETTLE_MS = 2_000;
const TITLE_LOG_CHARS = 50;

export interface Credentials {
  username: string;
  password: string;
}

export interface DiscourseForumOptions {
  site: Site;
  page: Page;
  deps: RuntimeDeps;
  /** B10: only CLI/Docker pass these, from the environment or stdin. */
  credentials?: Credentials;
  warn?: (code: string, message: string) => void;
}

/** T02: deep mode enters the category sorted by reply count through the URL; quick mode uses the plain list. */
export function listUrlFor(site: Pick<Site, 'baseUrl'>, category: Pick<Category, 'path'>, browseMode: BrowseMode): string {
  const url = new URL(category.path, site.baseUrl);
  if (browseMode === 'deep') url.search = SORTED_BY_POSTS_QUERY;
  return url.href;
}

/** T10: a sorted list must come back still sorted. */
export function sortKept(listUrl: string, currentUrl: string): boolean {
  const wanted = new URL(listUrl).searchParams.get('order');
  return wanted === null || new URL(currentUrl).searchParams.get('order') === wanted;
}

/**
 * T11: the row found again by topic ID decides. A missing row proves nothing, so it is
 * `indeterminate`, never success.
 */
export function classifyReturn(row: { newTopicBadge: boolean } | null): ReadVerification {
  if (!row) return 'indeterminate';
  return row.newTopicBadge ? 'still-unread' : 'confirmed';
}

/** §7.1 step 2 / Appendix A: top-level categories only; a subcategory's path carries its parent's slug. */
export function discoveredCategories(links: readonly CategoryLink[]): Category[] {
  return links
    .filter((l) => /^\/c\/[^/]+\/\d+$/.test(l.path))
    .map((l) => ({ name: l.name, path: l.path, id: l.id, enabledByDefault: false }));
}

const CLOSED = /Target page, context or browser has been closed|Browser has been closed|Target closed/;

/** Playwright's error once the browser window or process is gone, e.g. the user closed the window. */
export function browserClosed(err: unknown): boolean {
  return err instanceof Error && CLOSED.test(err.message);
}

/** Playwright navigation errors carry Chrome's net error code in the message. */
export function navigationFailure(err: unknown): RunFailure {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
  let code: ErrorCode = 'internal';
  if (browserClosed(err)) code = 'cancelled';
  else if (err instanceof Error && err.name === 'TimeoutError') code = 'page-timeout';
  else if (/net::ERR_(PROXY|TUNNEL)/.test(message)) code = 'proxy-failed';
  else if (/net::ERR_/.test(message)) code = 'network-failed';
  return { code, message };
}

/**
 * Reports a vanished browser as `cancelled` from every port method: whoever closed the window
 * ended the run, and nothing on the site can be checked any more.
 */
export function closedAsCancelled(forum: ForumPort): ForumPort {
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (browserClosed(err)) throw new RunError('cancelled', 'The browser was closed');
        throw err;
      }
    };
  return {
    site: forum.site,
    ensureAuthenticated: guard(forum.ensureAuthenticated.bind(forum)),
    discoverCategories: guard(forum.discoverCategories.bind(forum)),
    readProgress: guard(forum.readProgress.bind(forum)),
    collectTopics: guard(forum.collectTopics.bind(forum)),
    enterFromList: guard(forum.enterFromList.bind(forum)),
    readTopic: guard(forum.readTopic.bind(forum)),
    performActions: guard(forum.performActions.bind(forum)),
    returnAndVerify: guard(forum.returnAndVerify.bind(forum)),
  };
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts, so long page waits honour a stop (S05). */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * §6.1 production `ForumPort`: one implementation for every Discourse site, configured only by
 * `Site`. It reads and navigates; the only form it ever submits is the B10 password login.
 */
export class DiscourseForum implements ForumPort {
  readonly site: Site;
  private readonly page: Page;
  private readonly deps: RuntimeDeps;
  private readonly warn: (code: string, message: string) => void;
  /** The list page the current topic was entered from; returns and failed entries come back to it. */
  private listUrl: string | null = null;

  constructor(private readonly opts: DiscourseForumOptions) {
    this.site = opts.site;
    this.page = opts.page;
    this.deps = opts.deps;
    this.warn = opts.warn ?? (() => {});
  }

  private url(path: string): string {
    return new URL(path, this.site.baseUrl).href;
  }

  private pause(minSec: number, maxSec: number, signal: AbortSignal): Promise<void> {
    return this.deps.sleeper.sleep(randomBetween(this.deps.random, minSec, maxSec) * 1000, signal);
  }

  private async goto(url: string, signal: AbortSignal, waitUntil: 'domcontentloaded' | 'commit' = 'domcontentloaded'): Promise<void> {
    try {
      await untilAbort(this.page.goto(url, { waitUntil }), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const f = navigationFailure(err);
      throw new RunError(f.code, f.message);
    }
  }

  private appears(locator: Locator, timeout: number, signal: AbortSignal, state: 'attached' | 'visible' = 'attached'): Promise<boolean> {
    return untilAbort(
      locator.first().waitFor({ state, timeout }).then(
        () => true,
        (err: unknown) => {
          if (browserClosed(err)) throw err;
          return false;
        },
      ),
      signal,
    );
  }

  private async count(selector: string): Promise<number> {
    // A navigation in progress destroys the execution context; that moment simply shows nothing.
    return this.page.locator(selector).count().catch((err: unknown) => {
      if (browserClosed(err)) throw err;
      return 0;
    });
  }

  private async challenged(): Promise<boolean> {
    if ((await this.count(CHALLENGE_SELECTOR)) > 0) return true;
    return CHALLENGE_TITLE.test(
      await this.page.title().catch((err: unknown) => {
        if (browserClosed(err)) throw err;
        return '';
      }),
    );
  }

  private readonly unlessClosed = (err: unknown): null => {
    if (browserClosed(err)) throw err;
    return null;
  };

  private onSite(): boolean {
    try {
      return new URL(this.page.url()).origin === new URL(this.site.baseUrl).origin;
    } catch {
      return false;
    }
  }

  async ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult> {
    try {
      if (mode === 'headed-wait') return await this.waitForUser(signal);
      const checked = await this.check(signal);
      if (mode === 'credentials' && checked.status === 'needs-auth' && this.opts.credentials) {
        return await this.passwordLogin(this.opts.credentials, signal);
      }
      return checked;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof RunError) return { status: 'failed', failure: { code: err.code, message: err.message } };
      throw err;
    }
  }

  /**
   * B04 without a person: one look at the site. The page is only loaded when it is elsewhere, so a
   * recheck during a headed login never reloads what the user is doing.
   */
  private async check(signal: AbortSignal): Promise<AuthResult> {
    if (this.onSite()) {
      if ((await this.count(SELECTORS.currentUser)) > 0) return { status: 'authenticated' };
      return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
    }
    await this.goto(this.site.baseUrl, signal);
    const start = this.deps.clock.monotonic();
    for (;;) {
      if ((await this.count(SELECTORS.currentUser)) > 0) return { status: 'authenticated' };
      if ((await this.count(`${ANONYMOUS_HEADER}, ${SELECTORS.loginUsername}`)) > 0) return { status: 'needs-auth' };
      if (this.deps.clock.monotonic() - start >= SIGN_IN_CHECK_MS) break;
      await this.deps.sleeper.sleep(1_000, signal);
    }
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** B04/B05: the person at the headed window signs in, solving whatever the site asks; nothing reloads. */
  private async waitForUser(signal: AbortSignal): Promise<AuthResult> {
    if (!this.onSite()) await this.goto(this.site.baseUrl, signal);
    const ok = await waitForCurrentUser(this.page, { signal, clock: this.deps.clock, sleeper: this.deps.sleeper });
    if (ok) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** B10: the three login-form selectors, then back to the home page to confirm with `#current-user`. */
  private async passwordLogin(credentials: Credentials, signal: AbortSignal): Promise<AuthResult> {
    await this.goto(this.url('/login'), signal);
    if (!(await this.appears(this.page.locator(SELECTORS.loginUsername), SIGN_IN_CHECK_MS, signal))) {
      return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
    }
    await this.page.locator(SELECTORS.loginUsername).fill(credentials.username);
    await this.pause(0.5, 1, signal);
    await this.page.locator(SELECTORS.loginPassword).fill(credentials.password);
    await this.pause(0.5, 1, signal);
    await this.page.locator(SELECTORS.loginButton).click();
    await this.appears(this.page.locator(SELECTORS.currentUser), SIGN_IN_CHECK_MS, signal);
    await this.goto(this.site.baseUrl, signal);
    if (await this.appears(this.page.locator(SELECTORS.currentUser), SIGN_IN_CHECK_MS, signal)) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** A list or categories page that never rendered: a lost session or a challenge explains it better than "empty". */
  private async explainMissingPage(): Promise<void> {
    if (await this.challenged()) throw new RunError('challenge-detected', `Challenge page at ${this.page.url()}`);
    if ((await this.count(SELECTORS.currentUser)) === 0) throw new RunError('needs-auth', `Signed out of ${this.site.displayName}`);
  }

  async discoverCategories(signal: AbortSignal): Promise<Category[]> {
    await this.goto(this.url('/categories'), signal);
    if (!(await this.appears(this.page.locator('a[href*="/c/"]'), LIST_WAIT_MS, signal))) {
      await this.explainMissingPage();
      return [];
    }
    await this.pause(1, 2, signal);
    return discoveredCategories(categoryLinks(parseDocument(await this.page.content()), this.site.baseUrl));
  }

  async collectTopics(category: Category, strategy: TopicStrategy, signal: AbortSignal): Promise<TopicBatch> {
    const listUrl = listUrlFor(this.site, category, strategy.browseMode);
    await this.goto(listUrl, signal);
    this.listUrl = listUrl;
    if (!(await this.appears(this.page.locator(SELECTORS.topicRow), LIST_WAIT_MS, signal))) {
      await this.explainMissingPage();
      return { category, topics: [], empty: true };
    }
    // Appendix B: list appeared + 1–2 s.
    await this.pause(1, 2, signal);
    const topics: TopicCandidate[] = parseTopicList(parseDocument(await this.page.content()))
      .filter((r) => r.id && r.hasTitleLink)
      .map((r) => ({ id: r.id, title: r.title.slice(0, TITLE_LOG_CHARS), unread: r.unread, pinned: r.pinned }));
    return { category, topics, empty: false };
  }

  async enterFromList(topic: TopicCandidate, signal: AbortSignal): Promise<TopicVisit> {
    throwIfAborted(signal);
    // T08: the title link on the current list page is the only way into a candidate; there is no URL fallback.
    const link = this.page.locator(`${rowSelector(topic.id)} ${SELECTORS.topicLink}`).first();
    if ((await link.count()) === 0) return { topic, entered: false, reason: 'row-not-on-list' };
    await untilAbort(link.scrollIntoViewIfNeeded(), signal);
    await this.pause(0.5, 1.5, signal);
    await untilAbort(link.click(), signal);

    const onTopic = await untilAbort(
      this.page.waitForURL(topicUrlPattern(topic.id), { timeout: ENTER_URL_MS }).then(
        () => true,
        (err: unknown) => {
          if (browserClosed(err)) throw err;
          return false;
        },
      ),
      signal,
    );
    const rendered =
      onTopic &&
      (await this.appears(this.page.locator(`${SELECTORS.floorWide}, ${SELECTORS.floorNarrow}, .topic-post`), ENTER_CONTENT_MS, signal));
    if (rendered) return { topic, entered: true };

    await this.backToList(signal);
    return { topic, entered: false, reason: onTopic ? 'topic-content-missing' : 'url-unchanged' };
  }

  /** After a failed entry the next candidate is clicked on the same list, so the list is restored first. */
  private async backToList(signal: AbortSignal): Promise<void> {
    if (!this.listUrl || this.page.url() === this.listUrl) return;
    await untilAbort(this.page.goBack({ waitUntil: 'commit' }).catch(this.unlessClosed), signal);
    if (await this.appears(this.page.locator(SELECTORS.topicRow), RETURN_ROW_MS, signal)) return;
    await this.goto(this.listUrl, signal);
    await this.appears(this.page.locator(SELECTORS.topicRow), LIST_WAIT_MS, signal);
  }

  async readTopic(visit: TopicVisit, strategy: ReadStrategy, signal: AbortSignal): Promise<ReadResult> {
    if (!visit.entered) return { startFloor: null, endFloor: null, scrolls: 0, stoppedByTarget: false, layout: null };
    const page = this.page;
    const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const surface: FloorSurface = {
      readCounter: async () => parseFloorCounter(parseDocument(await page.content())),
      async scroll(dy) {
        // Real wheel input over the post stream: Discourse's screen tracker pauses when it sees no scroll events (§3).
        await page.mouse.move(Math.round(width / 2), Math.round(height / 2));
        await page.mouse.wheel(0, dy);
      },
    };
    return readFloors(surface, strategy, this.deps, signal);
  }

  /** Interactions are not part of this build: nothing is liked or replied to. */
  async performActions(_policy: ActionPolicy, _signal: AbortSignal): Promise<ActionResult> {
    const none = { attempted: 0, confirmed: 0 };
    return { likes: none, replyLikes: { ...none }, replies: { ...none }, likeLimitHit: false };
  }

  async returnAndVerify(visit: TopicVisit, signal: AbortSignal): Promise<ReadVerification> {
    if (!visit.entered) return 'indeterminate';
    const id = visit.topic.id;
    await untilAbort(this.page.goBack({ waitUntil: 'commit' }).catch(this.unlessClosed), signal);
    const row = this.page.locator(rowSelector(id));
    let found = await this.appears(row, RETURN_ROW_MS, signal, 'visible');
    if (!found && this.listUrl) {
      // T10: one refresh to re-check before calling it indeterminate.
      this.warn('return-row-missing', `Topic ${id} was not on the list after going back; reloading the list once`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, RETURN_ROW_MS, signal, 'visible');
    }
    // T10 / §3: 2–3 s on the list lets the site flush the topic's last /topics/timings.
    await this.pause(2, 3, signal);
    if (this.listUrl && !sortKept(this.listUrl, this.page.url())) {
      this.warn('sort-lost', `Back on ${this.page.url()} instead of ${this.listUrl}; reopening the sorted list`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, LIST_WAIT_MS, signal, 'visible');
    }
    if (!found) return 'indeterminate';
    return classifyReturn({ newTopicBadge: (await row.locator(SELECTORS.newTopicBadge).count()) > 0 });
  }

  async readProgress(kind: 'initial' | 'final', signal: AbortSignal): Promise<LevelSnapshot | null> {
    const module = progressModuleFor(this.site);
    if (!module || !this.site.progressUrl) return null;
    return module.source === 'connect-linuxdo' ? this.readConnect(this.site.progressUrl, signal) : this.readTrustLevel(this.site.progressUrl, signal);
  }

  /** S07 for connect: enter, wait 2 s, force a reload, wait for the page, then parse (§5.1). */
  private async readConnect(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const ready = () => this.appears(this.page.locator(CONNECT_READY), PROGRESS_READY_MS, signal);
    await this.goto(url, signal);
    // Without any tl3 group the parser raises selector-contract-broken, which is exactly the report §5.1 asks for.
    if (!(await ready())) return parseConnect(parseDocument(await this.page.content()));
    await this.deps.sleeper.sleep(CONNECT_SETTLE_MS, signal);
    await untilAbort(this.page.reload({ waitUntil: 'domcontentloaded' }), signal);
    await ready();
    return parseConnect(parseDocument(await this.page.content()));
  }

  /** S07 for docofcard: the table's rows mark readiness; the loader stays in the DOM after they render (§5.1b). */
  private async readTrustLevel(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const untilRows = async () => {
      if (await this.appears(this.page.locator(TRUST_LEVEL_SELECTORS.rows), TRUST_LEVEL_READY_MS, signal)) return;
      const page = parseTrustLevel(parseDocument(await this.page.content()));
      if (page.state === 'loading') throw new RunError('page-timeout', `No ${TRUST_LEVEL_SELECTORS.rows} within ${TRUST_LEVEL_READY_MS / 1000} s`);
    };
    await this.goto(url, signal, 'commit');
    await untilRows();
    await untilAbort(this.page.reload({ waitUntil: 'commit' }), signal);
    await untilRows();
    const parsed = parseTrustLevel(parseDocument(await this.page.content()));
    if (parsed.state !== 'ready') throw new RunError('page-timeout', 'Trust level table disappeared after reload');
    // B04: the username comes from where /my/trust-level redirected.
    const user = /\/u\/([^/?#]+)/.exec(new URL(this.page.url()).pathname)?.[1];
    return user && !parsed.snapshot.username ? { ...parsed.snapshot, username: decodeURIComponent(user) } : parsed.snapshot;
  }
}
