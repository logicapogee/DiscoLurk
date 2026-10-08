import { SELECTORS, abbreviatedCount, parseTopicList } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture, type SiteId } from './fixtures';

type ListFile = 'list.html' | 'list-sorted.html';

/**
 * Badge counts the captured pages actually carry. docofcard had no never-visited or updated topic
 * when captured (docs/PHASE0_REPORT.md), so its zeros are the expected reading, not a parse miss.
 */
const BADGES: Readonly<Record<SiteId, Record<ListFile, { newTopic: number; unreadPosts: number; pinned: number }>>> = {
  linuxdo: {
    'list.html': { newTopic: 29, unreadPosts: 0, pinned: 1 },
    'list-sorted.html': { newTopic: 0, unreadPosts: 3, pinned: 0 },
  },
  docofcard: {
    'list.html': { newTopic: 0, unreadPosts: 0, pinned: 1 },
    'list-sorted.html': { newTopic: 0, unreadPosts: 0, pinned: 1 },
  },
};

describe.each(SITE_IDS)('LIST-001 topic list parsing (T03–T05) — %s', (site) => {
  describe.each(['list.html', 'list-sorted.html'] as const)('%s', (file) => {
    const doc = fixture(site, file);
    const rows = parseTopicList(doc);
    const rowEls = Array.from(doc.querySelectorAll(SELECTORS.topicRow));

    it('reads one entry per tr.topic-list-item[data-topic-id], keeping its topic ID', () => {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toHaveLength(rowEls.length);
      expect(rows.map((r) => r.id)).toEqual(rowEls.map((el) => el.getAttribute('data-topic-id')));
      for (const r of rows) expect(r.id).toMatch(/^\d+$/);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    });

    it('finds exactly one title link per row', () => {
      const linksInRows = rowEls.map((el) => count(el, SELECTORS.topicLink));
      expect(linksInRows.every((n) => n === 1)).toBe(true);
      expect(count(doc, `${SELECTORS.topicRow} ${SELECTORS.topicLink}`)).toBe(rows.length);
      for (const r of rows) {
        expect(r.hasTitleLink).toBe(true);
        expect(r.title).not.toBe('');
      }
    });

    it('marks tr.pinned rows as pinned and only those', () => {
      const pinnedIds = rowEls.filter((el) => el.matches(SELECTORS.pinnedRow)).map((el) => el.getAttribute('data-topic-id'));
      expect(rows.filter((r) => r.pinned).map((r) => r.id)).toEqual(pinnedIds);
      expect(pinnedIds).toHaveLength(BADGES[site][file].pinned);
    });

    it('reads the new-topic and unread-posts badges per row', () => {
      const expected = BADGES[site][file];
      expect(rows.filter((r) => r.unread)).toHaveLength(expected.newTopic);
      expect(rows.filter((r) => r.unreadPosts)).toHaveLength(expected.unreadPosts);
      for (const [i, el] of rowEls.entries()) {
        expect(rows[i]!.unread).toBe(el.querySelector(SELECTORS.newTopicBadge) !== null);
        expect(rows[i]!.unreadPosts).toBe(el.querySelector(SELECTORS.unreadPostsBadge) !== null);
      }
    });

    it('treats only the new-topic badge as unread (T05)', () => {
      for (const r of rows.filter((r) => r.unreadPosts)) {
        const el = rowEls.find((e) => e.getAttribute('data-topic-id') === r.id)!;
        expect(r.unread).toBe(el.querySelector(SELECTORS.newTopicBadge) !== null);
      }
    });
  });

  it('reads a reply count on every row of the sorted list, in descending order', () => {
    const replies = parseTopicList(fixture(site, 'list-sorted.html')).map((r) => r.replies);
    expect(replies.every((n) => typeof n === 'number')).toBe(true);
    const counts = replies as number[];
    expect(counts.slice(0, 5)).toEqual([...counts.slice(0, 5)].sort((a, b) => b - a));
  });

  it('carries a pinned row on the default list', () => {
    expect(parseTopicList(fixture(site, 'list.html')).some((r) => r.pinned)).toBe(true);
  });
});

describe('reply counts as lists print them', () => {
  it.each([
    ['57', 57],
    ['1,234', 1234],
    ['1.2k', 1200],
    ['6.5K', 6500],
    ['3.4万', 34000],
    ['', null],
  ] as const)('%s → %s', (raw, n) => {
    expect(abbreviatedCount(raw)).toBe(n);
  });
});
