import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { DiscoLurkCoordinator, type RunEvent, type RunPlanSnapshot } from '@disco-lurk/core';
import { fixtureSite, VirtualTime } from '@disco-lurk/core/testing';
import { classifyReturn, discoveredCategories, DiscourseForum, listUrlFor, navigationFailure, sortKept } from './forum';
import { expectedMiss, type ReadOnlyPage } from './page';
import { usernameFromUrl } from './auth';
import { loginForm } from './session';
import { parseDocument } from './parse';

const site = { baseUrl: 'https://forum.docofcard.com' };

describe('LIST-001 list entry per browse mode (T02)', () => {
  it('deep mode opens the category sorted by replies through the URL; quick mode uses the plain list', () => {
    expect(listUrlFor(site, { path: '/c/bank/6' }, 'deep')).toBe('https://forum.docofcard.com/c/bank/6?order=posts');
    expect(listUrlFor(site, { path: '/c/bank/6' }, 'quick')).toBe('https://forum.docofcard.com/c/bank/6');
    expect(listUrlFor({ baseUrl: 'https://linux.do' }, { path: '/c/resource/cloud-asset/94' }, 'deep')).toBe(
      'https://linux.do/c/resource/cloud-asset/94?order=posts',
    );
  });
});

describe('NAV-003 sorted list survives the return (T10)', () => {
  it('requires ?order=posts back on a sorted list and nothing on a plain one', () => {
    const sorted = 'https://linux.do/c/develop/4?order=posts';
    expect(sortKept(sorted, 'https://linux.do/c/develop/4?order=posts')).toBe(true);
    expect(sortKept(sorted, 'https://linux.do/c/develop/4')).toBe(false);
    expect(sortKept(sorted, 'https://linux.do/c/develop/4?order=activity')).toBe(false);
    expect(sortKept('https://linux.do/c/develop/4', 'https://linux.do/c/develop/4')).toBe(true);
  });
});

describe('NAV-004 badge verification by topic id (T11)', () => {
  it('has exactly three outcomes and never calls a missing row a success', () => {
    expect(classifyReturn({ newTopicBadge: false })).toBe('confirmed');
    expect(classifyReturn({ newTopicBadge: true })).toBe('still-unread');
    expect(classifyReturn(null)).toBe('indeterminate');
  });
});

describe('CAT-001 top-level categories only (Appendix A)', () => {
  it('drops subcategories and starts every discovered category disabled', () => {
    const out = discoveredCategories([
      { name: '资源荟萃', path: '/c/resource/14', id: 14 },
      { name: '资源荟萃, Lv1', path: '/c/resource/resource-lv1/83', id: 83 },
      { name: '卡片交流', path: '/c/bank/6', id: 6 },
    ]);
    expect(out).toEqual([
      { name: '资源荟萃', path: '/c/resource/14', id: 14, enabledByDefault: false },
      { name: '卡片交流', path: '/c/bank/6', id: 6, enabledByDefault: false },
    ]);
  });
});

describe('navigation error classification (§6.4)', () => {
  it('maps Chrome net errors and timeouts to error codes', () => {
    const timeout = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
    expect(navigationFailure(timeout).code).toBe('page-timeout');
    expect(navigationFailure(new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://linux.do/')).code).toBe('proxy-failed');
    expect(navigationFailure(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://linux.do/')).code).toBe('network-failed');
    expect(navigationFailure(new Error('page.goto: Protocol error (Page.navigate): Internal')).code).toBe('internal');
  });
});

describe('page reads that may come up empty', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('treats only a timeout or a lost execution context as an expected miss', () => {
    expect(expectedMiss(named('TimeoutError', 'locator.waitFor: Timeout 20000ms exceeded.'))).toBe(true);
    expect(expectedMiss(new Error('locator.count: Execution context was destroyed, most likely because of a navigation'))).toBe(true);
    expect(expectedMiss(named('TargetClosedError', 'locator.count: Target page, context or browser has been closed'))).toBe(false);
    expect(expectedMiss(new Error('page.goBack: net::ERR_ABORTED'))).toBe(false);
  });
});

describe('username from the /my redirect (B04)', () => {
  it('reads and decodes the /u/<name> segment, and nothing else', () => {
    expect(usernameFromUrl('https://forum.docofcard.com/u/alice/summary')).toBe('alice');
    expect(usernameFromUrl('https://linux.do/u/%E5%BC%A0%E4%B8%89/activity')).toBe('张三');
    expect(usernameFromUrl('https://linux.do/my/activity')).toBeNull();
  });
});

/**
 * A page whose address and DOM are set by the test; waits answer at once from the current DOM.
 * Navigations are recorded but change nothing by themselves; `onNavigate` decides what the next page shows.
 */
class StaticPage implements ReadOnlyPage {
  readonly navigations: string[] = [];
  onNavigate: (kind: 'goto' | 'reload' | 'goBack', url?: string) => void = () => {};
  scrollError: Error | null = null;

  constructor(
    public address: string,
    public html: string,
  ) {}
  private all(selector: string) {
    return Array.from(parseDocument(this.html).querySelectorAll(selector));
  }
  async goto(url: string) {
    this.navigations.push(`goto ${url}`);
    this.onNavigate('goto', url);
  }
  async reload() {
    this.navigations.push('reload');
    this.onNavigate('reload');
  }
  async goBack() {
    this.navigations.push('goBack');
    this.onNavigate('goBack');
  }
  url() {
    return this.address;
  }
  async title() {
    return '';
  }
  isClosed() {
    return false;
  }
  async viewportSize() {
    return { width: 1280, height: 800 };
  }
  async setViewportSize() {}
  async content() {
    return this.html;
  }
  async count(selector: string) {
    return this.all(selector).length;
  }
  async text(selector: string) {
    return (await this.texts(selector))[0] ?? null;
  }
  async texts(selector: string) {
    return this.all(selector).map((e) => (e.textContent ?? '').trim());
  }
  async waitFor(selector: string) {
    if (this.all(selector).length === 0) throw timeoutError(`waitFor ${selector}`);
  }
  async waitForURL(url: RegExp) {
    if (!url.test(this.address)) throw timeoutError(`waitForURL ${url}`);
  }
  async scrollIntoView() {
    if (this.scrollError) throw this.scrollError;
  }
  async moveMouse() {}
  async wheel() {}
}

const timeoutError = (message: string) => Object.assign(new Error(message), { name: 'TimeoutError' });

function forumWith(page: ReadOnlyPage, over: Partial<ConstructorParameters<typeof DiscourseForum>[0]> = {}) {
  const time = new VirtualTime();
  const warnings: string[] = [];
  const forum = new DiscourseForum({
    site: fixtureSite({ baseUrl: 'https://linux.do' }),
    page,
    titleLinks: { click: async () => {} },
    deps: time.deps(),
    headless: true,
    warn: (code) => warnings.push(code),
    ...over,
  });
  return { time, forum, warnings };
}

describe('connect OAuth authorization page (§5.1)', () => {
  const CONNECT = 'https://connect.linux.do/';
  const AUTHORIZE_URL = 'https://connect.linux.do/oauth2/authorize?client_id=x';
  const authorizeHtml = '<html><body><h1>授权</h1><form action="/oauth2/authorize" method="post"><button type="submit">允许</button></form></body></html>';
  const progressHtml =
    '<html><body><div class="card-subtitle">@alice · 用户</div>' +
    '<div class="tl3-bar-item"><span class="tl3-bar-label">浏览话题</span><span class="tl3-bar-nums">120/500</span></div></body></html>';

  function forumOn(page: StaticPage, headless: boolean) {
    const t = forumWith(page, { site: fixtureSite({ baseUrl: 'https://linux.do', progressSource: 'connect-linuxdo', progressUrl: CONNECT }), headless });
    return { ...t, read: () => t.time.drive(t.forum.readProgress('final', new AbortController().signal)) };
  }

  it('headed: waits for the user to authorize, then reads the progress page', async () => {
    const page = new StaticPage(AUTHORIZE_URL, authorizeHtml);
    const t = forumOn(page, false);
    t.time.at(60_000, () => {
      page.address = CONNECT;
      page.html = progressHtml;
    });
    const snapshot = await t.read();
    expect(t.warnings).toEqual(['awaiting-authorization']);
    expect(snapshot?.metrics).toEqual([{ label: '浏览话题', key: 'topicsViewed', current: 120, required: 500 }]);
    expect(t.time.clock.monotonic()).toBeGreaterThanOrEqual(60_000);
  });

  it('headed: ends as needs-auth after 5 minutes without authorization, never selector-contract-broken', async () => {
    const t = forumOn(new StaticPage(AUTHORIZE_URL, authorizeHtml), false);
    await expect(t.read()).rejects.toMatchObject({ code: 'needs-auth' });
    expect(t.time.clock.monotonic()).toBe(300_000);
  });

  it('headless: needs-auth at once, asking for one headed run', async () => {
    const t = forumOn(new StaticPage(AUTHORIZE_URL, authorizeHtml), true);
    await expect(t.read()).rejects.toMatchObject({ code: 'needs-auth', message: expect.stringMatching(/headed/) });
    expect(t.warnings).toEqual([]);
    expect(t.time.clock.monotonic()).toBe(0);
  });

  it('recognises the page by its authorize form alone, and by an OAuth address alone', async () => {
    await expect(forumOn(new StaticPage(CONNECT, authorizeHtml), true).read()).rejects.toMatchObject({ code: 'needs-auth' });
    await expect(forumOn(new StaticPage(AUTHORIZE_URL, '<html><body>授权</body></html>'), true).read()).rejects.toMatchObject({ code: 'needs-auth' });
  });

  it('a connect page that is neither progress nor authorization still breaks the contract', async () => {
    const t = forumOn(new StaticPage(CONNECT, '<html><body><a href="/oauth2/log">授权日志</a></body></html>'), true);
    await expect(t.read()).rejects.toMatchObject({ code: 'selector-contract-broken' });
  });

  it('a page that loses its progress on the forced reload is a page-timeout, not a broken contract', async () => {
    const page = new StaticPage(CONNECT, progressHtml);
    page.onNavigate = (kind) => {
      if (kind === 'reload') page.html = '<html><body><div class="spinner"></div></body></html>';
    };
    await expect(forumOn(page, true).read()).rejects.toMatchObject({ code: 'page-timeout' });
  });
});

describe('docofcard trust level page while signed out', () => {
  const TRUST = 'https://forum.docofcard.com/my/trust-level';
  const site = fixtureSite({ baseUrl: 'https://forum.docofcard.com', progressSource: 'trust-level-docofcard', progressUrl: TRUST });
  const read = (page: StaticPage) => {
    const t = forumWith(page, { site });
    return t.time.drive(t.forum.readProgress('final', new AbortController().signal));
  };

  it('reports needs-auth when the site shows its login page instead of the table', async () => {
    const login = '<html><body><header class="d-header"><button class="login-button">登录</button></header><input id="login-account-name"></body></html>';
    await expect(read(new StaticPage('https://forum.docofcard.com/login', login))).rejects.toMatchObject({ code: 'needs-auth' });
  });

  it('reports needs-auth when the table is gone after the reload because the session ended', async () => {
    const loader = '<div class="docofcard-tools-trust-level-progress-loader"></div>';
    const table =
      '<header><a id="current-user"></a></header><table class="docofcard-tools-trust-level-progress__table"><tbody>' +
      '<tr class="is-complete"><th scope="row">进入过的主题</th><td>✓</td><td>9</td><td>5</td></tr></tbody></table>';
    const page = new StaticPage(TRUST, table);
    page.onNavigate = (kind) => {
      if (kind === 'reload') page.html = loader;
    };
    await expect(read(page)).rejects.toMatchObject({ code: 'needs-auth' });
  });
});

describe('entering from the list and getting back to it (T08, T10)', () => {
  const LIST = 'https://linux.do/c/develop/4?order=posts';
  const listHtml =
    '<header><a id="current-user"></a></header><table><tbody>' +
    '<tr class="topic-list-item" data-topic-id="7"><td><a class="title raw-link raw-topic-link" href="/t/seven/7">Seven</a>' +
    '<span class="badge badge-notification new-topic"></span></td></tr></tbody></table>';
  const topic = { id: '7', title: 'Seven', unread: true, pinned: false };

  async function onList(over: Partial<ConstructorParameters<typeof DiscourseForum>[0]> = {}) {
    const page = new StaticPage('https://linux.do/', listHtml);
    const t = forumWith(page, over);
    const signal = new AbortController().signal;
    await t.time.drive(t.forum.collectTopics({ name: 'develop', path: '/c/develop/4', id: 4, enabledByDefault: true }, { browseMode: 'deep' }, signal));
    page.navigations.length = 0;
    page.address = LIST;
    return { ...t, page, enter: () => t.time.drive(t.forum.enterFromList(topic, signal)) };
  }

  it('a title link that never becomes clickable skips only that topic as click-failed', async () => {
    const t = await onList({
      titleLinks: {
        click: async () => {
          throw timeoutError('locator.click: Timeout 10000ms exceeded.');
        },
      },
    });
    await expect(t.enter()).resolves.toEqual({ topic, entered: false, reason: 'click-failed' });
    expect(t.page.navigations).toEqual([]);
  });

  it('a row that cannot be scrolled into view is click-failed as well', async () => {
    const t = await onList();
    t.page.scrollError = timeoutError('locator.scrollIntoViewIfNeeded: Timeout 10000ms exceeded.');
    await expect(t.enter()).resolves.toMatchObject({ entered: false, reason: 'click-failed' });
  });

  it('a click that left the sorted list in place (address rewritten with a trailing slash) navigates nowhere', async () => {
    const t = await onList();
    t.page.address = 'https://linux.do/c/develop/4/?order=posts';
    await expect(t.enter()).resolves.toMatchObject({ entered: false, reason: 'url-unchanged' });
    expect(t.page.navigations).toEqual([]);
  });

  it('a list that lost its sort order is reloaded by address', async () => {
    const t = await onList();
    t.page.address = 'https://linux.do/c/develop/4';
    await expect(t.enter()).resolves.toMatchObject({ entered: false, reason: 'url-unchanged' });
    expect(t.page.navigations).toEqual([`goto ${LIST}`]);
  });

  it('a topic page that never rendered goes one step back to the list', async () => {
    const t = await onList({
      titleLinks: {
        click: async () => {
          t.page.address = 'https://linux.do/t/seven/7';
          t.page.html = '<html><body></body></html>';
        },
      },
    });
    t.page.onNavigate = (kind) => {
      if (kind !== 'goBack') return;
      t.page.address = LIST;
      t.page.html = listHtml;
    };
    await expect(t.enter()).resolves.toMatchObject({ entered: false, reason: 'topic-content-missing' });
    expect(t.page.navigations).toEqual(['goBack']);
  });
});

describe('B10 password login keeps the credentials out of every report', () => {
  const SECRET = 'hunter2-Sup3rSecret';

  it('a failing login form yields a RunResult and events that never contain the password', async () => {
    const site = fixtureSite({ baseUrl: 'https://forum.docofcard.com', login: 'password' });
    const page = new StaticPage('https://forum.docofcard.com/', '<header><button class="login-button"></button></header><input id="login-account-name">');
    // Playwright quotes the value it was asked to type in some failures.
    const leaky = (value: string) => Object.assign(new Error(`locator.fill: Element is not an <input> while filling "${value}"`), { name: 'Error' });
    const fakePage = {
      locator: () => ({
        fill: async (value: string) => {
          if (value === SECRET) throw leaky(value);
        },
        click: async () => {},
      }),
    } as unknown as Pick<Page, 'locator'>;
    const time = new VirtualTime();
    const forum = new DiscourseForum({
      site,
      page,
      titleLinks: { click: async () => {} },
      deps: time.deps(),
      headless: true,
      login: { credentials: { username: 'alice', password: SECRET }, form: loginForm(fakePage, time.deps(), (fn) => fn()) },
    });
    const coordinator = new DiscoLurkCoordinator({
      deps: time.deps(),
      resolveProfile: async (id) => ({ profile: { id, siteId: site.id, channel: 'chrome' }, site }),
      open: async () => ({ forum, closed: new AbortController().signal, close: async () => {} }),
      categories: { load: async () => [], save: async () => {} },
    });
    const events: RunEvent[] = [];
    const plan = {
      id: 'run-1',
      siteId: site.id,
      profileId: 'fixture/main',
      browserMode: 'headless',
      seed: 1,
      plannedAt: '2026-10-08T00:00:00.000Z',
      materializedAt: '2026-10-08T00:00:00.000Z',
      preset: {
        presetId: 'p',
        browseMode: 'quick',
        runMode: { kind: 'endless' },
        categories: [{ name: 'a', path: '/c/a/1', id: 1, enabledByDefault: true }],
        interaction: { like: { enabled: false, topicRate: 0, replyRate: 0, maxReplies: 0 }, reply: { enabled: false, rate: 0 } },
        extraWait: { enabled: false, minSec: 1, maxSec: 3 },
        samplePerCategory: { min: 1, max: 1 },
      },
    } as const satisfies RunPlanSnapshot;
    const result = await time.drive(coordinator.run(structuredClone(plan) as RunPlanSnapshot, new AbortController().signal, (e) => events.push(e)));
    expect(result.failure).toEqual({ code: 'needs-auth', message: 'password failed: Error' });
    const report = JSON.stringify({ result, events });
    expect(report).not.toContain(SECRET);
    expect(report).not.toContain('alice');
  });
});
