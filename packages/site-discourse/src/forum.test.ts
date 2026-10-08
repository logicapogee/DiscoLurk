import { describe, expect, it } from 'vitest';
import { classifyReturn, discoveredCategories, listUrlFor, navigationFailure, sortKept } from './forum';
import { expectedMiss } from './page';
import { usernameFromUrl } from './auth';

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
