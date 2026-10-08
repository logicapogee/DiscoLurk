import type { Category } from '@disco-lurk/core';
import { CATEGORY_PATH, categoryLinks, discoveredCategories } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { readData } from '../logic/data';
import { BASE_URL, SITE_IDS, fixture, textOf } from './fixtures';

const appendixC = (readData('categories.json') as { categories: Category[] }).categories;

/** docofcard's ten top-level categories as its category-box headings name them. */
const DOCOFCARD_NAMES = ['卡片交流', '运营反馈', '人工智能', '号码交流', 'General', 'Feed', '卡友活动', '交易拼车', '热点消息', '行旅常客'];

describe.each(SITE_IDS)('CAT-001 category discovery from /categories (§7.1 step 2, Appendix A) — %s', (site) => {
  const doc = fixture(site, 'categories.html');
  const found = categoryLinks(doc, BASE_URL[site]);

  it('reads a name, slug and id for every entry', () => {
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      const m = CATEGORY_PATH.exec(c.path);
      expect(m, c.path).not.toBeNull();
      expect(c.id).toBe(Number(m![2]));
      expect(m![1]!.split('/').at(-1)).toMatch(/^[\w-]+$/);
      expect(c.name).not.toBe('');
    }
    expect(new Set(found.map((c) => c.id)).size).toBe(found.length);
  });

  it('skips subcategory badges', () => {
    const badgePaths = Array.from(doc.querySelectorAll('.subcategories a[href], .subcategory a[href]'))
      .map((a) => new URL(a.getAttribute('href')!, BASE_URL[site]).pathname)
      .filter((p) => CATEGORY_PATH.test(p));
    const foundPaths = new Set(found.map((c) => c.path));
    for (const p of badgePaths) expect(foundPaths.has(p), p).toBe(false);
  });

  it('skips the unread/new counter links under each category', () => {
    for (const c of found) expect(c.path).not.toMatch(/\/l\/(new|unread)$/);
  });

  it('discovers every category listed as its own entry: linuxdo 20, docofcard 10', () => {
    const discovered = discoveredCategories(found);
    expect(discovered).toHaveLength(site === 'linuxdo' ? 20 : 10);
    if (site === 'linuxdo') expect(discovered.map((c) => c.path)).toContain('/c/resource/cloud-asset/94');
  });

  if (site === 'linuxdo') {
    it('finds at least the 16 Appendix C categories with their names', () => {
      expect(found.length).toBeGreaterThanOrEqual(16);
      expect(appendixC).toHaveLength(16);
      for (const builtin of appendixC) {
        expect(found.find((c) => c.path === builtin.path), builtin.path).toEqual({
          name: builtin.name,
          path: builtin.path,
          id: builtin.id,
        });
      }
    });

    it('has a subcategory badge in the fixture to skip', () => {
      expect(doc.querySelectorAll('.subcategories a.badge-category__wrapper').length).toBeGreaterThan(0);
    });
  } else {
    it('finds exactly the ten top-level categories', () => {
      expect(found).toHaveLength(10);
      expect(found.map((c) => c.name)).toEqual(DOCOFCARD_NAMES);
    });

    it('takes the name from the box heading, not the link text that runs in the description', () => {
      for (const c of found) {
        const box = doc.querySelector(`a.category-box[href="${c.path}"]`);
        expect(box, c.path).not.toBeNull();
        expect(c.name).toBe(textOf(box!.querySelector('.category-box-heading h3')));
        expect(textOf(box)).not.toBe(c.name);
      }
    });
  }
});
