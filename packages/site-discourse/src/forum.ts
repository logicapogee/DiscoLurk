import {
  isAbortError,
  LOGIN_WAIT_MS,
  pauseBetween,
  RunError,
  throwIfAborted,
  untilAbort,
  type ActionPolicy,
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
  type TopicListSource,
  type TopicStrategy,
  type TopicVisit,
} from '@disco-lurk/core';
import { PageActionSurface, performActions, templatePicker, type Composer, type LikeButton } from './actions';
import { LOGIN_POLL_MS, pollUntil, usernameFromUrl, waitForCurrentUser } from './auth';
import { expectedMiss, type LoadState, type ReadOnlyPage } from './page';
import { categoryLinks, floorCounterFromText, parseDocument, parseTopicList, type CategoryLink, type FloorReading } from './parse';
import { parseConnect } from './progress/connect-linuxdo';
import { PROGRESS_READY_MS, progressModuleFor, TRUST_LEVEL_READY_MS } from './progress/index';
import { parseTrustLevel, TRUST_LEVEL_SELECTORS } from './progress/trust-level-docofcard';
import { readFloors, type FloorSurface } from './reading';
import {
  ANONYMOUS_HEADER,
  CATEGORY_LINK,
  CATEGORY_PATH,
  CHALLENGE_SELECTOR,
  CHALLENGE_TITLE,
  CONNECT_AUTHORIZE_FORM,
  CONNECT_AUTHORIZE_PATH,
  CONNECT_READY,
  LIST_END,
  rowSelector,
  SELECTORS,
  SORTED_BY_POSTS_QUERY,
  TOPIC_POST,
  topicUrlPattern,
} from './selectors';

/** Page-load ceilings; reading pace lives in reading.ts and is not shortened by fast pages. */
const TIMEOUTS = {
  listMs: 20_000,
  enterUrlMs: 15_000,
  enterContentMs: 10_000,
  returnRowMs: 15_000,
  signInCheckMs: 20_000,
  signInPollMs: 1_000,
  connectSettleMs: 2_000,
  visibilityPollMs: 2_000,
} as const;
const TITLE_LOG_CHARS = 50;

export interface Credentials {
  username: string;
  password: string;
}

/** The one click a run makes on a site, on a topic's title link in the current list. */
export interface TitleLinks {
  click(topicId: string): Promise<void>;
}

/** Fills and submits the site's login form, pacing the fields like a person. */
export interface LoginForm {
  submit(credentials: Credentials, signal: AbortSignal): Promise<void>;
}

export interface DiscourseForumOptions {
  site: Site;
  page: ReadOnlyPage;
  titleLinks: TitleLinks;
  likeButton: LikeButton;
  composer: Composer;
  /** Reply texts; each is used at most once per run. */
  replyTemplates: readonly string[];
  deps: RuntimeDeps;
  /** Whether a person can act in the window, e.g. approve connect's authorization page. */
  headless: boolean;
  /** Only CLI/Docker pass credentials, from the environment or stdin. */
  login?: { credentials: Credentials; form: LoginForm };
  warn?: (code: string, message: string) => void;
}

/** The selector of a topic's title link in its list row. */
export const titleLinkSelector = (topicId: string) => `${rowSelector(topicId)} ${SELECTORS.topicLink}`;

/**
 * Deep mode enters the category sorted by reply count through the URL; quick mode uses the plain
 * list. A filtered list (`new`, `unread`) is the category path plus `/l/<filter>`.
 */
export function listUrlFor(site: Pick<Site, 'baseUrl'>, category: Pick<Category, 'path'>, browseMode: BrowseMode, source: TopicListSource = 'category'): string {
  const url = new URL(source === 'category' ? category.path : `${category.path.replace(/\/$/, '')}/l/${source}`, site.baseUrl);
  if (browseMode === 'deep') url.search = SORTED_BY_POSTS_QUERY;
  return url.href;
}

/** A sorted list must come back still sorted. */
export function sortKept(listUrl: string, currentUrl: string): boolean {
  const wanted = new URL(listUrl).searchParams.get('order');
  return wanted === null || new URL(currentUrl).searchParams.get('order') === wanted;
}

/**
 * The row found again by topic ID decides. A missing row proves nothing, so it is
 * `indeterminate`, never success. Only a topic that carried the `new-topic` badge before it was
 * entered can lose it; for any other topic the relocated row is all there is to report.
 */
export function classifyReturn(hadBadge: boolean, row: { newTopicBadge: boolean } | null): ReadVerification {
  if (!row) return 'indeterminate';
  if (!hadBadge) return 'not-applicable';
  return row.newTopicBadge ? 'still-unread' : 'confirmed';
}

/**
 * Every category the page lists as an entry of its own counts, a
 * subcategory with its own row (`/c/resource/cloud-asset/94`) included; badges never reach here.
 */
export function discoveredCategories(links: readonly CategoryLink[]): Category[] {
  return links
    .filter((l) => CATEGORY_PATH.test(l.path))
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

/** A page read that comes up empty yields `value`; any other failure is rethrown. */
const fallbackUnlessUnexpected =
  <T>(value: T) =>
  (err: unknown): T => {
    if (expectedMiss(err)) return value;
    throw err;
  };

/**
 * The site's screen tracker counts nothing while the page is hidden, so a hidden headed window
 * is raised once and the caller waits until it is visible again, or until `signal` ends the wait.
 * A headless page is always visible.
 */
class VisibilityGate {
  constructor(private readonly opts: Pick<DiscourseForumOptions, 'page' | 'deps' | 'headless'> & { warn: (code: string, message: string) => void }) {}

  async whenVisible(signal: AbortSignal): Promise<void> {
    const { page, deps, headless, warn } = this.opts;
    if (headless || page.visibilityState() === 'visible') return;
    const since = deps.clock.monotonic();
    warn('page-hidden', 'The browser window is hidden; the site counts no reading while it is. Bringing it to the front and waiting');
    await untilAbort(page.bringToFront(), signal);
    const { clock, sleeper } = deps;
    await pollUntil({ intervalMs: TIMEOUTS.visibilityPollMs, timeoutMs: Number.POSITIVE_INFINITY, clock, sleeper }, async () => (page.visibilityState() === 'visible' ? true : null), signal);
    const seconds = Math.round((deps.clock.monotonic() - since) / 1000);
    warn('page-visible', `The browser window is visible again after ${seconds} s; reading continues`);
  }
}

/** A topic page as reading sees it: the floor counters' text and wheel input over the post stream. */
class PageFloorSurface implements FloorSurface {
  private pointed = false;

  constructor(
    private readonly page: ReadOnlyPage,
    private readonly center: { x: number; y: number },
    private readonly gate: VisibilityGate,
  ) {}

  whenVisible(signal: AbortSignal): Promise<void> {
    return this.gate.whenVisible(signal);
  }

  async readCounter(): Promise<FloorReading | null> {
    const texts = await Promise.all([this.page.text(SELECTORS.floorWide), this.page.texts(SELECTORS.floorNarrow)]).catch(fallbackUnlessUnexpected(null));
    return texts && floorCounterFromText(...texts);
  }

  countPosts(): Promise<number> {
    return this.page.count(TOPIC_POST).catch(fallbackUnlessUnexpected(0));
  }

  async scroll(dy: number): Promise<void> {
    // Real wheel input over the post stream: Discourse's screen tracker pauses when it sees no scroll events.
    if (!this.pointed) {
      await this.page.moveMouse(this.center.x, this.center.y);
      this.pointed = true;
    }
    await this.page.wheel(0, dy);
  }
}

/**
 * The production `ForumPort`: one implementation for every Discourse site, configured only by
 * `Site`. It reads and navigates; the only form it ever submits is the password login.
 */
export class DiscourseForum implements ForumPort {
  private readonly opts: DiscourseForumOptions & Required<Pick<DiscourseForumOptions, 'warn'>>;
  /** The list page the current topic was entered from; returns and failed entries come back to it. */
  private listUrl: string | null = null;
  private readonly nextTemplate: () => string | null;
  /** The only holder of the like button and the composer. */
  private readonly actions: PageActionSurface;
  private readonly visibility: VisibilityGate;

  constructor(opts: DiscourseForumOptions) {
    this.opts = { warn: () => {}, ...opts };
    this.nextTemplate = templatePicker(opts.replyTemplates, opts.deps.random);
    this.actions = new PageActionSurface(opts.page, opts.likeButton, opts.composer, opts.deps, this.opts.warn);
    this.visibility = new VisibilityGate(this.opts);
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
    return untilAbort(this.opts.page.waitFor(selector, { state, timeout }).then(() => true, fallbackUnlessUnexpected(false)), signal);
  }

  private async count(selector: string): Promise<number> {
    return this.opts.page.count(selector).catch(fallbackUnlessUnexpected(0));
  }

  private async challenged(): Promise<boolean> {
    const [marks, title] = await Promise.all([this.count(CHALLENGE_SELECTOR), this.opts.page.title().catch(fallbackUnlessUnexpected(''))]);
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
   * The sign-in check without a person: one look at the site. The page is only loaded when it is elsewhere, so a
   * recheck during a headed login never reloads what the user is doing.
   */
  private async check(signal: AbortSignal): Promise<AuthResult> {
    if (this.onSite()) {
      if ((await this.count(SELECTORS.currentUser)) > 0) return { status: 'authenticated' };
      return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
    }
    await this.goto(this.site.baseUrl, signal);
    const settled = await pollUntil<AuthResult>(
      { intervalMs: TIMEOUTS.signInPollMs, timeoutMs: TIMEOUTS.signInCheckMs, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper },
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

  /** The person at the headed window signs in, solving whatever the site asks; nothing reloads. */
  private async waitForUser(signal: AbortSignal): Promise<AuthResult> {
    if (!this.onSite()) await this.goto(this.site.baseUrl, signal);
    const ok = await waitForCurrentUser(this.opts.page, { signal, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper });
    if (ok) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** The three login-form selectors, then back to the home page to confirm with `#current-user`. */
  private async passwordLogin(login: NonNullable<DiscourseForumOptions['login']>, signal: AbortSignal): Promise<AuthResult> {
    await this.goto(this.url('/login'), signal);
    if (!(await this.appears(SELECTORS.loginUsername, TIMEOUTS.signInCheckMs, signal))) {
      return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
    }
    await login.form.submit(login.credentials, signal);
    await this.appears(SELECTORS.currentUser, TIMEOUTS.signInCheckMs, signal);
    await this.goto(this.site.baseUrl, signal);
    if (await this.appears(SELECTORS.currentUser, TIMEOUTS.signInCheckMs, signal)) return { status: 'authenticated' };
    return (await this.challenged()) ? { status: 'challenge-detected' } : { status: 'needs-auth' };
  }

  /** A list or categories page that never rendered: a lost session or a challenge explains it better than "empty". */
  private async explainMissingPage(): Promise<void> {
    if (await this.challenged()) throw new RunError('challenge-detected', `Challenge page at ${this.opts.page.url()}`);
    if ((await this.count(SELECTORS.currentUser)) === 0) throw new RunError('needs-auth', `Signed out of ${this.site.displayName}`);
  }

  async discoverCategories(signal: AbortSignal): Promise<Category[]> {
    await this.goto(this.url('/categories'), signal);
    if (!(await this.appears(CATEGORY_LINK, TIMEOUTS.listMs, signal))) {
      await this.explainMissingPage();
      return [];
    }
    await this.pause(1, 2, signal);
    return discoveredCategories(categoryLinks(await this.content(), this.site.baseUrl));
  }

  async collectTopics(category: Category, strategy: TopicStrategy, signal: AbortSignal): Promise<TopicBatch> {
    for (const source of strategy.lists ?? []) {
      const batch = await this.openList(category, source, strategy.browseMode, signal);
      if (batch.topics.length > 0) return batch;
    }
    return this.openList(category, 'category', strategy.browseMode, signal);
  }

  /**
   * A category's own list must show topic rows; a filtered list may legitimately be empty, so its
   * end-of-list footer also counts as rendered.
   */
  private async openList(category: Category, source: TopicListSource, browseMode: BrowseMode, signal: AbortSignal): Promise<TopicBatch> {
    const listUrl = listUrlFor(this.site, category, browseMode, source);
    await this.goto(listUrl, signal);
    this.listUrl = listUrl;
    const rendered = source === 'category' ? SELECTORS.topicRow : `${SELECTORS.topicRow}, ${LIST_END}`;
    if (!(await this.appears(rendered, TIMEOUTS.listMs, signal)) || (await this.count(SELECTORS.topicRow)) === 0) {
      await this.explainMissingPage();
      return { category, source, topics: [] };
    }
    // A person glances over the list for 1–2 s once it appears.
    await this.pause(1, 2, signal);
    const topics: TopicCandidate[] = parseTopicList(await this.content())
      .filter((r) => r.id && r.hasTitleLink)
      .map((r) => ({
        id: r.id,
        title: r.title.slice(0, TITLE_LOG_CHARS),
        unread: r.unread,
        pinned: r.pinned,
        unreadPosts: r.unreadPosts,
        ...(r.replies !== null ? { replies: r.replies } : {}),
      }));
    // docofcard's Feed category renders news cards as topic rows without a title link:
    // nothing on such a page can be clicked, so it is as empty as a page without rows.
    return { category, source, topics };
  }

  async enterFromList(topic: TopicCandidate, signal: AbortSignal): Promise<TopicVisit> {
    throwIfAborted(signal);
    // The title link on the current list page is the only way into a candidate; there is no URL fallback.
    const link = titleLinkSelector(topic.id);
    if ((await this.opts.page.count(link)) === 0) return { topic, entered: false, reason: 'row-not-on-list' };
    await this.visibility.whenVisible(signal);
    try {
      await untilAbort(this.opts.page.scrollIntoView(link), signal);
      await untilAbort(this.opts.titleLinks.click(topic.id), signal);
    } catch (err) {
      // A row that never becomes clickable costs this topic only; the next candidate is on the same list.
      if (err instanceof Error && err.name === 'TimeoutError') return { topic, entered: false, reason: 'click-failed' };
      throw err;
    }

    const onTopic = await untilAbort(this.opts.page.waitForURL(topicUrlPattern(topic.id), { timeout: TIMEOUTS.enterUrlMs }).then(() => true, fallbackUnlessUnexpected(false)), signal);
    const rendered = onTopic && (await this.appears(`${SELECTORS.floorWide}, ${SELECTORS.floorNarrow}, ${TOPIC_POST}`, TIMEOUTS.enterContentMs, signal));
    if (rendered) return { topic, entered: true };

    await this.backToList(topic.id, signal);
    return { topic, entered: false, reason: onTopic ? 'topic-content-missing' : 'url-unchanged' };
  }

  /**
   * Whether the page shows the list the current topic was entered from. Discourse may rewrite the
   * address (a trailing slash, extra query parameters), so the path and the sort order decide.
   */
  private onList(): boolean {
    if (!this.listUrl) return false;
    try {
      const current = new URL(this.opts.page.url());
      const wanted = new URL(this.listUrl);
      const path = (u: URL) => u.pathname.replace(/\/+$/, '');
      return current.origin === wanted.origin && path(current) === path(wanted) && sortKept(this.listUrl, current.href);
    } catch {
      return false;
    }
  }

  /**
   * After a failed entry the next candidate is clicked on the same list, so the list is restored
   * first: one step back from the topic that was opened, otherwise a fresh load of the list.
   */
  private async backToList(topicId: string, signal: AbortSignal): Promise<void> {
    if (!this.listUrl || this.onList()) return;
    if (topicUrlPattern(topicId).test(this.opts.page.url())) {
      await untilAbort(this.opts.page.goBack('commit').catch(fallbackUnlessUnexpected(undefined)), signal);
      if (this.onList() && (await this.appears(SELECTORS.topicRow, TIMEOUTS.returnRowMs, signal))) return;
    }
    await this.goto(this.listUrl, signal);
    await this.appears(SELECTORS.topicRow, TIMEOUTS.listMs, signal);
  }

  async readTopic(visit: TopicVisit, strategy: ReadStrategy, signal: AbortSignal): Promise<ReadResult> {
    if (!visit.entered) return { startFloor: null, endFloor: null, scrolls: 0, stoppedByTarget: false, layout: null };
    const { width, height } = await this.opts.page.viewportSize();
    const surface = new PageFloorSurface(this.opts.page, { x: Math.round(width / 2), y: Math.round(height / 2) }, this.visibility);
    return readFloors(surface, strategy, this.opts.deps, signal);
  }

  /**
   * Not wrapped in `untilAbort`: a stop lands at the next wait inside, and a reply stopped after
   * typing must finish discarding its draft before the run moves on.
   */
  performActions(policy: ActionPolicy, signal: AbortSignal): Promise<void> {
    return performActions(this.actions, policy, this.opts.deps, { nextTemplate: this.nextTemplate, warn: this.opts.warn }, signal);
  }

  async returnAndVerify(visit: TopicVisit, signal: AbortSignal): Promise<ReadVerification> {
    if (!visit.entered) return 'indeterminate';
    const id = visit.topic.id;
    await untilAbort(this.opts.page.goBack('commit').catch(fallbackUnlessUnexpected(undefined)), signal);
    const row = rowSelector(id);
    let found = await this.appears(row, TIMEOUTS.returnRowMs, signal, 'visible');
    if (!found && this.listUrl) {
      // One refresh to re-check before calling it indeterminate.
      this.opts.warn('return-row-missing', `Topic ${id} was not on the list after going back; reloading the list once`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, TIMEOUTS.returnRowMs, signal, 'visible');
    }
    // 2–3 s on the list lets the site flush the topic's last /topics/timings.
    await this.pause(2, 3, signal);
    if (this.listUrl && !sortKept(this.listUrl, this.opts.page.url())) {
      this.opts.warn('sort-lost', `Back on ${this.opts.page.url()} instead of ${this.listUrl}; reopening the sorted list`);
      await this.goto(this.listUrl, signal);
      found = await this.appears(row, TIMEOUTS.listMs, signal, 'visible');
    }
    if (!found) return classifyReturn(visit.topic.unread, null);
    return classifyReturn(visit.topic.unread, { newTopicBadge: (await this.opts.page.count(`${row} ${SELECTORS.newTopicBadge}`)) > 0 });
  }

  async readProgress(kind: 'initial' | 'final', signal: AbortSignal): Promise<LevelSnapshot | null> {
    const module = progressModuleFor(this.site);
    if (!module || !this.site.progressUrl) return null;
    return module.source === 'connect-linuxdo' ? this.readConnect(this.site.progressUrl, signal) : this.readTrustLevel(this.site.progressUrl, signal);
  }

  /** Connect: enter, wait 2 s, force a reload, wait for the page, then parse. */
  private async readConnect(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const ready = () => this.appears(CONNECT_READY, PROGRESS_READY_MS, signal);
    await this.goto(url, signal);
    await this.appears(`${CONNECT_READY}, ${CONNECT_AUTHORIZE_FORM}`, PROGRESS_READY_MS, signal);
    if ((await this.count(CONNECT_READY)) === 0) {
      // Without any tl3 group the parser raises selector-contract-broken, which is exactly the report a changed page deserves.
      if (!(await this.onConnectAuthorizePage())) return parseConnect(await this.content());
      await this.awaitConnectAuthorization(url, signal);
    }
    await this.opts.deps.sleeper.sleep(TIMEOUTS.connectSettleMs, signal);
    await untilAbort(this.opts.page.reload('domcontentloaded'), signal);
    if (!(await ready())) throw new RunError('page-timeout', `${new URL(url).host} showed no progress within ${PROGRESS_READY_MS / 1000} s after the reload`);
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
   * Authorization is the user's to give. A headed window waits for it like a login, never
   * reloading; a headless run cannot get it and ends as needs-auth.
   */
  private async awaitConnectAuthorization(url: string, signal: AbortSignal): Promise<void> {
    const host = new URL(url).host;
    if (this.opts.headless) {
      throw new RunError('needs-auth', `${host} asks to authorize access; run once with a headed window (--headed) and approve it there`);
    }
    this.opts.warn('awaiting-authorization', `${host} asks to authorize access; approve it in the browser window (waiting up to ${LOGIN_WAIT_MS / 60_000} minutes)`);
    const authorized = await pollUntil(
      { intervalMs: LOGIN_POLL_MS, timeoutMs: LOGIN_WAIT_MS, clock: this.opts.deps.clock, sleeper: this.opts.deps.sleeper },
      async () => ((await this.count(CONNECT_READY)) > 0 ? true : null),
      signal,
    );
    if (!authorized) throw new RunError('needs-auth', `${host} authorization was not given within ${LOGIN_WAIT_MS / 60_000} minutes`);
  }

  /** Docofcard: the table's rows mark readiness; the loader stays in the DOM after they render. */
  private async readTrustLevel(url: string, signal: AbortSignal): Promise<LevelSnapshot> {
    const untilRows = async () => {
      if (await this.appears(TRUST_LEVEL_SELECTORS.rows, TRUST_LEVEL_READY_MS, signal)) return;
      await this.explainMissingPage();
      const page = parseTrustLevel(await this.content());
      if (page.state === 'loading') throw new RunError('page-timeout', `No ${TRUST_LEVEL_SELECTORS.rows} within ${TRUST_LEVEL_READY_MS / 1000} s`);
    };
    await this.goto(url, signal, 'commit');
    await untilRows();
    await untilAbort(this.opts.page.reload('commit'), signal);
    await untilRows();
    const parsed = parseTrustLevel(await this.content());
    if (parsed.state !== 'ready') {
      await this.explainMissingPage();
      throw new RunError('page-timeout', 'Trust level table disappeared after reload');
    }
    // The username comes from where /my/trust-level redirected.
    const user = usernameFromUrl(this.opts.page.url());
    return user && !parsed.snapshot.username ? { ...parsed.snapshot, username: user } : parsed.snapshot;
  }
}
