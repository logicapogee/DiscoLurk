import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { DiscoLurkCoordinator, type RunEvent, type RunPlanSnapshot } from '@disco-lurk/core';
import { fixtureSite, VirtualTime } from '@disco-lurk/core/testing';
import { classifyReturn, discoveredCategories, DiscourseForum, listUrlFor, navigationFailure, sortKept } from './forum';
import { expectedMiss, type ReadOnlyPage } from './page';
import { StaticPage, timeoutError } from './testing';
import { usernameFromUrl } from './auth';
import { loginForm, timingsReceipt, timingsUrlOf } from './session';
import { parseDocument, parseTimingsBody } from './parse';

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
  it('a topic that had the badge has three outcomes and a missing row is never a success', () => {
    expect(classifyReturn(true, { newTopicBadge: false })).toBe('confirmed');
    expect(classifyReturn(true, { newTopicBadge: true })).toBe('still-unread');
    expect(classifyReturn(true, null)).toBe('indeterminate');
  });

  it('a topic entered without the badge is not-applicable once its row is found again', () => {
    expect(classifyReturn(false, { newTopicBadge: false })).toBe('not-applicable');
    expect(classifyReturn(false, null)).toBe('indeterminate');
  });
});

describe('CAT-001 every category listed as its own entry (Appendix A)', () => {
  it('keeps subcategories with their own row and starts every discovered category disabled', () => {
    const out = discoveredCategories([
      { name: '资源荟萃', path: '/c/resource/14', id: 14 },
      { name: '网盘资源', path: '/c/resource/cloud-asset/94', id: 94 },
      { name: '卡片交流', path: '/c/bank/6', id: 6 },
      { name: 'new', path: '/c/bank/6/l/new', id: 6 },
    ]);
    expect(out).toEqual([
      { name: '资源荟萃', path: '/c/resource/14', id: 14, enabledByDefault: false },
      { name: '网盘资源', path: '/c/resource/cloud-asset/94', id: 94, enabledByDefault: false },
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


function forumWith(page: ReadOnlyPage, over: Partial<ConstructorParameters<typeof DiscourseForum>[0]> = {}) {
  const time = new VirtualTime();
  const warnings: string[] = [];
  const forum = new DiscourseForum({
    site: fixtureSite({ baseUrl: 'https://linux.do' }),
    page,
    titleLinks: { click: async () => {} },
    likeButton: { click: async () => {} },
    composer: { open: async () => {}, fill: async () => {}, submit: async () => {}, discard: async () => {} },
    replyTemplates: [],
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

  it('clicks without a pause in front of the click', async () => {
    const t = await onList({
      titleLinks: {
        click: async () => {
          clickedAt = t.time.clock.monotonic();
          t.page.address = 'https://linux.do/t/seven/7';
          t.page.html = '<div class="topic-post"></div>';
        },
      },
    });
    let clickedAt = -1;
    const start = t.time.clock.monotonic();
    await expect(t.enter()).resolves.toEqual({ topic, entered: true });
    expect(clickedAt).toBe(start);
  });

  it('returns not-applicable for a topic entered without the new-topic badge', async () => {
    const t = await onList();
    const visit = { topic: { ...topic, unread: false }, entered: true as const };
    await expect(t.time.drive(t.forum.returnAndVerify(visit, new AbortController().signal))).resolves.toBe('not-applicable');
    const withBadge = { topic, entered: true as const };
    await expect(t.time.drive(t.forum.returnAndVerify(withBadge, new AbortController().signal))).resolves.toBe('still-unread');
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
      likeButton: { click: async () => {} },
      composer: { open: async () => {}, fill: async () => {}, submit: async () => {}, discard: async () => {} },
      replyTemplates: [],
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
        experiments: { useNewList: false, useUnreadList: false, refreshCategories: false, smartRanked: false },
      },
    } as const satisfies RunPlanSnapshot;
    const result = await time.drive(coordinator.run(structuredClone(plan) as RunPlanSnapshot, new AbortController().signal, (e) => events.push(e)));
    expect(result.failure).toEqual({ code: 'needs-auth', message: 'password failed: Error' });
    const report = JSON.stringify({ result, events });
    expect(report).not.toContain(SECRET);
    expect(report).not.toContain('alice');
  });
});

describe('VIS-001 a hidden headed window pauses reading (I6)', () => {
  const LIST = 'https://linux.do/c/develop/4';
  const listHtml =
    '<header><a id="current-user"></a></header><table><tbody>' +
    '<tr class="topic-list-item" data-topic-id="7"><td><a class="title raw-link raw-topic-link" href="/t/seven/7">Seven</a></td></tr></tbody></table>';
  const topic = { id: '7', title: 'Seven', unread: false, pinned: false };

  async function onList(headless: boolean) {
    const page = new StaticPage(LIST, listHtml);
    let clickedAt = -1;
    const t = forumWith(page, {
      headless,
      titleLinks: {
        click: async () => {
          clickedAt = t.time.clock.monotonic();
          page.address = 'https://linux.do/t/seven/7';
          page.html = '<div class="topic-post"></div>';
        },
      },
    });
    const signal = new AbortController().signal;
    await t.time.drive(t.forum.collectTopics({ name: 'develop', path: '/c/develop/4', id: 4, enabledByDefault: true }, { browseMode: 'quick' }, signal));
    return { ...t, page, clickedAt: () => clickedAt, signal };
  }

  it('raises the window once, waits until it is visible, and only then clicks', async () => {
    const t = await onList(false);
    t.page.visibility = 'hidden';
    const start = t.time.clock.monotonic();
    t.time.at(start + 7_000, () => (t.page.visibility = 'visible'));
    await expect(t.time.drive(t.forum.enterFromList(topic, t.signal))).resolves.toMatchObject({ entered: true });
    expect(t.page.fronted).toBe(1);
    expect(t.clickedAt()).toBeGreaterThanOrEqual(start + 7_000);
    expect(t.warnings).toEqual(['page-hidden', 'page-visible']);
  });

  it('a stop while hidden ends the wait at once', async () => {
    const t = await onList(false);
    t.page.visibility = 'hidden';
    const controller = new AbortController();
    t.time.at(t.time.clock.monotonic() + 3_000, () => controller.abort());
    await expect(t.time.drive(t.forum.enterFromList(topic, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.clickedAt()).toBe(-1);
  });

  it('a window that stays hidden waits only until the signal ends it, while entering and while reading', async () => {
    const t = await onList(false);
    t.page.visibility = 'hidden';
    const entering = new AbortController();
    t.time.at(t.time.clock.monotonic() + 60_000, () => entering.abort());
    await expect(t.time.drive(t.forum.enterFromList(topic, entering.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.clickedAt()).toBe(-1);

    t.page.visibility = 'visible';
    const visit = await t.time.drive(t.forum.enterFromList(topic, t.signal));
    t.page.visibility = 'hidden';
    const reading = new AbortController();
    const until = t.time.clock.monotonic() + 90_000;
    t.time.at(until, () => reading.abort());
    await expect(t.time.drive(t.forum.readTopic(visit, { browseMode: 'deep', onFloor: () => 'continue' }, reading.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.time.clock.monotonic()).toBe(until);
  });

  it('never checks a headless page, which is always visible', async () => {
    const t = await onList(true);
    t.page.visibility = 'hidden';
    await expect(t.time.drive(t.forum.enterFromList(topic, t.signal))).resolves.toMatchObject({ entered: true });
    expect(t.page.fronted).toBe(0);
    expect(t.warnings).toEqual([]);
  });
});

describe('filtered candidate lists (§7.2 useNewList / useUnreadList)', () => {
  const cat = { name: 'develop', path: '/c/develop/4', id: 4, enabledByDefault: true };
  const rows = (ids: string[], badge = '') =>
    '<header><a id="current-user"></a></header><table><tbody>' +
    ids.map((id) => `<tr class="topic-list-item" data-topic-id="${id}"><td><a class="title raw-link raw-topic-link" href="/t/t/${id}">T${id}</a>${badge}</td></tr>`).join('') +
    '</tbody></table><footer class="topic-list-bottom"></footer>';

  it('builds /l/new and /l/unread under the category, sorted in deep mode', () => {
    expect(listUrlFor({ baseUrl: 'https://linux.do' }, cat, 'quick', 'new')).toBe('https://linux.do/c/develop/4/l/new');
    expect(listUrlFor({ baseUrl: 'https://linux.do' }, cat, 'deep', 'unread')).toBe('https://linux.do/c/develop/4/l/unread?order=posts');
  });

  it('uses the first filtered list that shows topics and reports where they came from', async () => {
    const page = new StaticPage('https://linux.do/', '');
    page.onNavigate = (_kind, url) => {
      page.address = url ?? page.address;
      page.html = url?.endsWith('/l/new') ? rows([]) : rows(['8', '9'], '<span class="badge-notification unread-posts"></span>');
    };
    const t = forumWith(page);
    const batch = await t.time.drive(t.forum.collectTopics(cat, { browseMode: 'quick', lists: ['new', 'unread'] }, new AbortController().signal));
    expect(page.navigations).toEqual(['goto https://linux.do/c/develop/4/l/new', 'goto https://linux.do/c/develop/4/l/unread']);
    expect(batch.source).toBe('unread');
    expect(batch.topics.map((r) => [r.id, r.unreadPosts])).toEqual([
      ['8', true],
      ['9', true],
    ]);
  });

  it('falls back to the category list when every filtered list is empty', async () => {
    const page = new StaticPage('https://linux.do/', '');
    page.onNavigate = (_kind, url) => {
      page.address = url ?? page.address;
      page.html = url?.includes('/l/') ? rows([]) : rows(['3']);
    };
    const t = forumWith(page);
    const batch = await t.time.drive(t.forum.collectTopics(cat, { browseMode: 'quick', lists: ['new'] }, new AbortController().signal));
    expect(batch).toMatchObject({ source: 'category', topics: [{ id: '3' }] });
  });

  it('asks only for the category list when no filtered list is requested', async () => {
    const page = new StaticPage('https://linux.do/', '');
    page.onNavigate = (_kind, url) => {
      page.address = url ?? page.address;
      page.html = rows(['3']);
    };
    const t = forumWith(page);
    await t.time.drive(t.forum.collectTopics(cat, { browseMode: 'deep' }, new AbortController().signal));
    expect(page.navigations).toEqual(['goto https://linux.do/c/develop/4?order=posts']);
  });
});

describe('TIMINGS-001 read receipts from the page (I7)', () => {
  it('parses the form-encoded body Discourse posts', () => {
    expect(parseTimingsBody('timings%5B1%5D=4000&timings%5B2%5D=4000&timings%5B12%5D=1000&topic_time=4000&topic_id=2996592')).toEqual({
      topicId: '2996592',
      postNumbers: [1, 2, 12],
      topicMs: 4000,
    });
  });

  it('parses a JSON body of the same shape and rejects bodies without a topic', () => {
    expect(parseTimingsBody(JSON.stringify({ timings: { '3': 1000 }, topic_time: 1500, topic_id: 7 }))).toEqual({ topicId: '7', postNumbers: [3], topicMs: 1500 });
    expect(parseTimingsBody('timings%5B1%5D=1000')).toBeNull();
    expect(parseTimingsBody(null)).toBeNull();
    expect(parseTimingsBody('{not json')).toBeNull();
  });

  const request = (url: string, opts: { method?: string; ok?: boolean; body?: string } = {}) => {
    let looked = 0;
    return {
      lookups: () => looked,
      url: () => url,
      method: () => opts.method ?? 'POST',
      postData: () => opts.body ?? 'timings%5B1%5D=1000&topic_time=1000&topic_id=5',
      response: async () => {
        looked++;
        return { ok: () => opts.ok ?? true };
      },
    };
  };

  it('accepts only a successful POST to the site’s own /topics/timings, looking up no other response', async () => {
    const timingsUrl = timingsUrlOf({ baseUrl: 'https://linux.do/' });
    expect(timingsUrl).toBe('https://linux.do/topics/timings');
    const r = (u: string, o?: Parameters<typeof request>[1]) => {
      const req = request(u, o);
      return timingsReceipt(timingsUrl, req as unknown as Parameters<typeof timingsReceipt>[1]).then((receipt) => ({ receipt, looked: req.lookups() }));
    };
    await expect(r('https://linux.do/topics/timings')).resolves.toEqual({ receipt: { topicId: '5', postNumbers: [1], topicMs: 1000 }, looked: 1 });
    await expect(r('https://linux.do/topics/timings?x=1')).resolves.toMatchObject({ looked: 1 });
    await expect(r('https://linux.do/topics/timings', { ok: false })).resolves.toEqual({ receipt: null, looked: 1 });
    await expect(r('https://linux.do/topics/timings', { method: 'GET' })).resolves.toEqual({ receipt: null, looked: 0 });
    await expect(r('https://linux.do/topics/timings-extra')).resolves.toEqual({ receipt: null, looked: 0 });
    await expect(r('https://connect.linux.do/topics/timings')).resolves.toEqual({ receipt: null, looked: 0 });
    await expect(r('https://linux.do/t/x/5.json')).resolves.toEqual({ receipt: null, looked: 0 });
  });
});
