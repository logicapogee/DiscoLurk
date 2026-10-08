import { describe, expect, it } from 'vitest';
import { fixtureSite, VirtualTime } from '@disco-lurk/core/testing';
import { classifyReturn, discoveredCategories, DiscourseForum, listUrlFor, navigationFailure, sortKept } from './forum';
import { expectedMiss, type ReadOnlyPage } from './page';
import { usernameFromUrl } from './auth';
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

describe('connect OAuth authorization page (§5.1)', () => {
  const CONNECT = 'https://connect.linux.do/';
  const AUTHORIZE_URL = 'https://connect.linux.do/oauth2/authorize?client_id=x';
  const authorizeHtml = '<html><body><h1>授权</h1><form action="/oauth2/authorize" method="post"><button type="submit">允许</button></form></body></html>';
  const progressHtml =
    '<html><body><div class="card-subtitle">@alice · 用户</div>' +
    '<div class="tl3-bar-item"><span class="tl3-bar-label">浏览话题</span><span class="tl3-bar-nums">120/500</span></div></body></html>';

  /** A page whose address and DOM are set by the test; waits answer at once from the current DOM. */
  class StaticPage implements ReadOnlyPage {
    constructor(
      public address: string,
      public html: string,
    ) {}
    private all(selector: string) {
      return Array.from(parseDocument(this.html).querySelectorAll(selector));
    }
    async goto() {}
    async reload() {}
    async goBack() {}
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
      if (this.all(selector).length === 0) throw Object.assign(new Error(`waitFor ${selector}`), { name: 'TimeoutError' });
    }
    async waitForURL() {}
    async scrollIntoView() {}
    async moveMouse() {}
    async wheel() {}
  }

  function forumOn(page: StaticPage, headless: boolean) {
    const time = new VirtualTime();
    const warnings: string[] = [];
    const forum = new DiscourseForum({
      site: fixtureSite({ baseUrl: 'https://linux.do', progressSource: 'connect-linuxdo', progressUrl: CONNECT }),
      page,
      titleLinks: { click: async () => {} },
      deps: time.deps(),
      headless,
      warn: (code) => warnings.push(code),
    });
    return { time, forum, warnings, read: () => time.drive(forum.readProgress('final', new AbortController().signal)) };
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
});
