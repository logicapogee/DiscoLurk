import {
  abortError,
  isAbortError,
  pauseBetween,
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
import { LOGIN_POLL_MS, LOGIN_TIMEOUT_MS, pollUntil, usernameFromUrl, waitForCurrentUser } from './auth';
import { expectedMiss, type LoadState, type ReadOnlyPage } from './page';
import { categoryLinks, floorCounterFromText, parseDocument, parseTopicList, type CategoryLink, type FloorReading } from './parse';
import { parseConnect } from './progress/connect-linuxdo';
import { PROGRESS_READY_MS, progressModuleFor, TRUST_LEVEL_READY_MS } from './progress/index';
import { parseTrustLevel, TRUST_LEVEL_SELECTORS } from './progress/trust-level-docofcard';
import { readFloors, type FloorSurface } from './reading';
import {
  ANONYMOUS_HEADER,
  CATEGORY_LINK,
  CHALLENGE_SELECTOR,
  CHALLENGE_TITLE,
  CONNECT_AUTHORIZE_FORM,
  CONNECT_AUTHORIZE_PATH,
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
const SIGN_IN_POLL_MS = 1_000;
const CONNECT_SETTLE_MS = 2_000;
const TITLE_LOG_CHARS = 50;

export interface Credentials {
  username: string;
  password: string;
}

/** T08: the one click a run makes on a site, on a topic's title link in the current list. */
export interface TitleLinks {
  click(topicId: string): Promise<void>;
}

/** B10: fills and submits the site's login form, pacing the fields like a person. */
export interface LoginForm {
  submit(credentials: Credentials, signal: AbortSignal): Promise<void>;
}

export interface DiscourseForumOptions {
  site: Site;
  page: ReadOnlyPage;
  titleLinks: TitleLinks;
  deps: RuntimeDeps;
  /** Whether a person can act in the window, e.g. approve connect's authorization page (§5.1). */
  headless: boolean;
  /** B10: only CLI/Docker pass credentials, from the environment or stdin. */
  login?: { credentials: Credentials; form: LoginForm };
  warn?: (code: string, message: string) => void;
}

/** The selector of a topic's title link in its list row (T08). */
export const titleLinkSelector = (topicId: string) => `${rowSelector(topicId)} ${SELECTORS.topicLink}`;

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

/** Playwright navigation errors carry Chrome's net error code in the message. */
export function navigationFailure(err: unknown): RunFailure {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
  let code: ErrorCode = 'internal';
  if (err instanceof Error && err.name === 'TimeoutError') code = 'page-timeout';
  else if (/net::ERR_(PROXY|TUNNEL)/.test(message)) code = 'proxy-failed';
  else if (/net::ERR_/.test(message)) code = 'network-failed';
  return { code, message };
}

const missAs =
  <T>(value: T) =>
  (err: unknown): T => {
    if (expectedMiss(err)) return value;
    throw err;
  };

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

/** A topic page as reading sees it: the floor counters' text and wheel input over the post stream. */
class PageFloorSurface implements FloorSurface {
  private pointed = false;

  constructor(
    private readonly page: ReadOnlyPage,
    private readonly center: { x: number; y: number },
  ) {}

  async readCounter(): Promise<FloorReading | null> {
    const texts = await Promise.all([this.page.text(SELECTORS.floorWide), this.page.texts(SELECTORS.floorNarrow)]).catch(missAs(null));
    return texts && floorCounterFromText(...texts);
  }

  async scroll(dy: number): Promise<void> {
    // Real wheel input over the post stream: Discourse's screen tracker pauses when it sees no scroll events (§3).
    if (!this.pointed) {
      await this.page.moveMouse(this.center.x, this.center.y);
      this.pointed = true;
    }
    await this.page.wheel(0, dy);
  }
}

/**
 * §6.1 production `ForumPort`: one implementation for every Discourse site, configured only by
 * `Site`. It reads and navigates; the only form it ever submits is the B10 password login.
 */
export class DiscourseForum implements ForumPort {
  private readonly opts: DiscourseForumOptions & Required<Pick<DiscourseForumOptions, 'warn'>>;
  /** The list page the current topic was entered from; returns and failed entries come back to it. */
  private listUrl: string | null = null;

  constructor(opts: DiscourseForumOptions) {
    this.opts = { warn: () => {}, ...opts };
  }

  get site(): Site {
    return this.opts.site;
  }


  private url(path: string): string {
    return new URL(path, this.site.baseUrl).href;
  }

  private pause(minSec: number, maxSec: number, signal: AbortSignal): Promise<void> {
    return pauseBetween(this.opts.deps, minSec, maxSec, signal);
  }

  private async goto(url: string, signal: AbortSignal, waitUntil: LoadState = 'domcontentloaded'): Promise<void> {
    try {
      await untilAbort(this.opts.page.goto(url, waitUntil), signal);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err;
      const f = navigationFailure(err);
      throw new RunError(f.code, f.message);
    }
  }

  private appears(selector: string, timeout: number, signal: AbortSignal, state: 'attached' | 'visible' = 'attached'): Promise<boolean> {
    return untilAbort(this.opts.page.waitFor(selector, { state, timeout }).then(() => true, missAs(false)), signal);
  }

  private async count(selector: string): Promise<number> {
    return this.opts.page.count(selector).catch(missAs(0));
  }

  private async challenged(): Promise<boolean> {
    const [marks, title] = await Promise.all([this.count(CHALLENGE_SELECTOR), this.opts.page.title().catch(missAs(''))]);
    return marks > 0 || CHALLENGE_TITLE.test(title);
  }

  private async content(): Promise<Document> {
    return parseDocument(await this.opts.page.content());
  }

  private onSite(): boolean {
    try {
      return new URL(this.opts.page.url()).origin === new URL(this.site.baseUrl).origin;
    } catch {
      return false;
    }
  }

  async ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult> {
    if (mode === 'headed-wait') return this.waitForUser(signal);
    const checked = await this.check(signal);
    if (mode === 'credentials' && checked.status === 'needs-auth' && this.opts.login) return this.passwordLogin(this.opts.login, signal);
    return checked;
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
    const settled = await pollUntil<AuthResult>(
      { intervalMs: SIGN_IN_POLL_MS, timeoutMs: SIGN_IN_CHECK_MS, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper },
      async () => {
        const [user, anonymous] = await Promise.all([this.count(SELECTORS.currentUser), this.count(`${ANONYMOUS_HEADER}, ${SELECTORS.loginUsername}`)]);
        if (user > 0) return { status: 'authenticated' };
        return anonymous > 0 ? { status: 'needs-auth' } : null;
      },
      signal,
    );
    if (settled) return settled;
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** B04/B05: the person at the headed window signs in, solving whatever the site asks; nothing reloads. */
  private async waitForUser(signal: AbortSignal): Promise<AuthResult> {
    if (!this.onSite()) await this.goto(this.site.baseUrl, signal);
    const ok = await waitForCurrentUser(this.opts.page, { signal, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper });
    if (ok) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** B10: the three login-form selectors, then back to the home page to confirm with `#current-user`. */
  private async passwordLogin(login: NonNullable<DiscourseForumOptions['login']>, signal: AbortSignal): Promise<AuthResult> {
    await this.goto(this.url('/login'), signal);
    if (!(await this.appears(SELECTORS.loginUsername, SIGN_IN_CHECK_MS, signal))) {
      return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
    }
    await login.form.submit(login.credentials, signal);
    await this.appears(SELECTORS.currentUser, SIGN_IN_CHECK_MS, signal);
    await this.goto(this.site.baseUrl, signal);
    if (await this.appears(SELECTORS.currentUser, SIGN_IN_CHECK_MS, signal)) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** A list or categories page that never rendered: a lost session or a challenge explains it better than "empty". */
  private async explainMissingPage(): Promise<void> {
    if (await this.challenged()) throw new RunError('challenge-detected', `Challenge page at ${this.opts.page.url()}`);
    if ((await this.count(SELECTORS.currentUser)) === 0) throw new RunError('needs-auth', `Signed out of ${this.site.displayName}`);
  }

  async discoverCategories(signal: AbortSignal): Promise<Category[]> {
    await this.goto(this.url('/categories'), signal);
    if (!(await this.appears(CATEGORY_LINK, LIST_WAIT_MS, signal))) {
      await this.explainMissingPage();
      return [];
    }
    await this.pause(1, 2, signal);
    return discoveredCategories(categoryLinks(await this.content(), this.site.baseUrl));
  }

  async collectTopics(category: Category, strategy: TopicStrategy, signal: AbortSignal): Promise<TopicBatch> {
    const listUrl = listUrlFor(this.site, category, strategy.browseMode);
    await this.goto(listUrl, signal);
    this.listUrl = listUrl;
    if (!(await this.appears(SELECTORS.topicRow, LIST_WAIT_MS, signal))) {
      await this.explainMissingPage();
      return { category, topics: [] };
    }
    // Appendix B: list appeared + 1–2 s.
    await this.pause(1, 2, signal);
    const topics: TopicCandidate[] = parseTopicList(await this.content())
      .filter((r) => r.id && r.hasTitleLink)
      .map((r) => ({ id: r.id, title: r.title.slice(0, TITLE_LOG_CHARS), unread: r.unread, pinned: r.pinned }));
    // docofcard's Feed category renders news cards as topic rows without a title link (Phase 1 smoke):
    // nothing on such a page can be clicked, so it is as empty as a page without rows.
    return { category, topics };
  }

  async enterFromList(topic: TopicCandidate, signal: AbortSignal): Promise<TopicVisit> {
    throwIfAborted(signal);
    // T08: the title link on the current list page is the only way into a candidate; there is no URL fallback.
    const link = titleLinkSelector(topic.id);
    if ((await this.opts.page.count(link)) === 0) return { topic, entered: false, reason: 'row-not-on-list' };
    await untilAbort(this.opts.page.scrollIntoView(link), signal);
    await this.pause(0.5, 1.5, signal);
    await untilAbort(this.opts.titleLinks.click(topic.id), signal);

    const onTopic = await untilAbort(this.opts.page.waitForURL(topicUrlPattern(topic.id), { timeout: ENTER_URL_MS }).then(() => true, missAs(false)), signal);
    const rendered = onTopic && (await this.appears(`${SELECTORS.floorWide}, ${SELECTORS.floorNarrow}, .topic-post`, ENTER_CONTENT_MS, signal));
    if (rendered) return { topic, entered: true };

    await this.backToList(signal);
    return { topic, entered: false, reason: onTopic ? 'topic-content-missing' : 'url-unchanged' };
  }

  /** After a failed entry the next candidate is clicked on the same list, so the list is restored first. */
  private async backToList(signal: AbortSignal): Promise<void> {
    if (!this.listUrl || this.opts.page.url() === this.listUrl) return;
    await untilAbort(this.opts.page.goBack('commit').catch(missAs(undefined)), signal);
    if (await this.appears(SELECTORS.topicRow, RETURN_ROW_MS, signal)) return;
    await this.goto(this.listUrl, signal);
    await this.appears(SELECTORS.topicRow, LIST_WAIT_MS, signal);
  }

  async readTopic(visit: TopicVisit, strategy: ReadStrategy, signal: AbortSignal): Promise<ReadResult> {
    if (!visit.entered) return { startFloor: null, endFloor: null, scrolls: 0, stoppedByTarget: false, layout: null };
    const { width, height } = await this.opts.page.viewportSize();
    const surface = new PageFloorSurface(this.opts.page, { x: Math.round(width / 2), y: Math.round(height / 2) });
    return readFloors(surface, strategy, this.opts.deps, signal);
  }

  /** Interactions are not part of this build: nothing is liked or replied to. */
  async performActions(_policy: ActionPolicy, _signal: AbortSignal): Promise<ActionResult> {
    const none = { attempted: 0, confirmed: 0 };
    return { likes: none, replyLikes: { ...none }, replies: { ...none }, likeLimitHit: false };
  }

  async returnAndVerify(visit: TopicVisit, signal: AbortSignal): Promise<ReadVerification> {
    if (!visit.entered) return 'indeterminate';
    const id = visit.topic.id;
    await untilAbort(this.opts.page.goBack('commit').catch(missAs(undefined)), signal);
    const row = rowSelector(id);
    let found = await this.appears(row, RETURN_ROW_MS, signal, 'visible');
    if (!found && this.listUrl) {
      // T10: one refresh to re-check before calling it indeterminate.
      this.opts.warn('return-row-missing', `Topic ${id} was not on the list after going back; reloading the list once`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, RETURN_ROW_MS, signal, 'visible');
    }
    // T10 / §3: 2–3 s on the list lets the site flush the topic's last /topics/timings.
    await this.pause(2, 3, signal);
    if (this.listUrl && !sortKept(this.listUrl, this.opts.page.url())) {
      this.opts.warn('sort-lost', `Back on ${this.opts.page.url()} instead of ${this.listUrl}; reopening the sorted list`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, LIST_WAIT_MS, signal, 'visible');
    }
    if (!found) return 'indeterminate';
    return classifyReturn({ newTopicBadge: (await this.opts.page.count(`${row} ${SELECTORS.newTopicBadge}`)) > 0 });
  }

  async readProgress(kind: 'initial' | 'final', signal: AbortSignal): Promise<LevelSnapshot | null> {
    const module = progressModuleFor(this.site);
    if (!module || !this.site.progressUrl) return null;
    return module.source === 'connect-linuxdo' ? this.readConnect(this.site.progressUrl, signal) : this.readTrustLevel(this.site.progressUrl, signal);
  }

  /** S07 for connect: enter, wait 2 s, force a reload, wait for the page, then parse (§5.1). */
  private async readConnect(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const ready = () => this.appears(CONNECT_READY, PROGRESS_READY_MS, signal);
    await this.goto(url, signal);
    await this.appears(`${CONNECT_READY}, ${CONNECT_AUTHORIZE_FORM}`, PROGRESS_READY_MS, signal);
    if ((await this.count(CONNECT_READY)) === 0) {
      // Without any tl3 group the parser raises selector-contract-broken, which is exactly the report §5.1 asks for.
      if (!(await this.onConnectAuthorizePage())) return parseConnect(await this.content());
      await this.awaitConnectAuthorization(url, signal);
    }
    await this.opts.deps.sleeper.sleep(CONNECT_SETTLE_MS, signal);
    await untilAbort(this.opts.page.reload('domcontentloaded'), signal);
    await ready();
    return parseConnect(await this.content());
  }

  private async onConnectAuthorizePage(): Promise<boolean> {
    let path = '';
    try {
      path = new URL(this.opts.page.url()).pathname;
    } catch {
      // An unparsable address leaves the form as the only sign.
    }
    return CONNECT_AUTHORIZE_PATH.test(path) || (await this.count(CONNECT_AUTHORIZE_FORM)) > 0;
  }

  /**
   * §5.1: authorization is the user's to give. A headed window waits for it like a login (B04), never
   * reloading; a headless run cannot get it and ends as needs-auth.
   */
  private async awaitConnectAuthorization(url: string, signal: AbortSignal): Promise<void> {
    const host = new URL(url).host;
    if (this.opts.headless) {
      throw new RunError('needs-auth', `${host} asks to authorize access; run once with a headed window (--headed) and approve it there`);
    }
    this.opts.warn('awaiting-authorization', `${host} asks to authorize access; approve it in the browser window (waiting up to ${LOGIN_TIMEOUT_MS / 60_000} minutes)`);
    const authorized = await pollUntil(
      { intervalMs: LOGIN_POLL_MS, timeoutMs: LOGIN_TIMEOUT_MS, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper },
      async () => ((await this.count(CONNECT_READY)) > 0 ? true : null),
      signal,
    );
    if (!authorized) throw new RunError('needs-auth', `${host} authorization was not given within ${LOGIN_TIMEOUT_MS / 60_000} minutes`);
  }

  /** S07 for docofcard: the table's rows mark readiness; the loader stays in the DOM after they render (§5.1b). */
  private async readTrustLevel(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const untilRows = async () => {
      if (await this.appears(TRUST_LEVEL_SELECTORS.rows, TRUST_LEVEL_READY_MS, signal)) return;
      const page = parseTrustLevel(await this.content());
      if (page.state === 'loading') throw new RunError('page-timeout', `No ${TRUST_LEVEL_SELECTORS.rows} within ${TRUST_LEVEL_READY_MS / 1000} s`);
    };
    await this.goto(url, signal, 'commit');
    await untilRows();
    await untilAbort(this.opts.page.reload('commit'), signal);
    await untilRows();
    const parsed = parseTrustLevel(await this.content());
    if (parsed.state !== 'ready') throw new RunError('page-timeout', 'Trust level table disappeared after reload');
    // B04: the username comes from where /my/trust-level redirected.
    const user = usernameFromUrl(this.opts.page.url());
    return user && !parsed.snapshot.username ? { ...parsed.snapshot, username: user } : parsed.snapshot;
  }
}
