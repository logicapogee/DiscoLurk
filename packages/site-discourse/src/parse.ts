import { parseHTML } from 'linkedom';
import { CATEGORY_NAME_SELECTORS, CATEGORY_PATH, SELECTORS } from './selectors';

/** Parsers take any DOM root so the same code reads a live page snapshot and a stored fixture. */
export type DomRoot = ParentNode;

export function parseDocument(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Digits only: counters may carry thousands separators or surrounding whitespace. */
export function toInt(raw: string | null | undefined): number | null {
  const digits = (raw ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

export interface ListRow {
  id: string;
  title: string;
  pinned: boolean;
  /** T05: only the `new-topic` badge marks a never-visited topic. */
  unread: boolean;
  unreadPosts: boolean;
  hasTitleLink: boolean;
}

/** T03–T05 */
export function parseTopicList(root: DomRoot): ListRow[] {
  return Array.from(root.querySelectorAll(SELECTORS.topicRow)).map((row) => {
    const link = row.querySelector(SELECTORS.topicLink);
    return {
      id: row.getAttribute('data-topic-id') ?? '',
      title: text(link),
      pinned: row.matches(SELECTORS.pinnedRow),
      unread: row.querySelector(SELECTORS.newTopicBadge) !== null,
      unreadPosts: row.querySelector(SELECTORS.unreadPostsBadge) !== null,
      hasTitleLink: link !== null,
    };
  });
}

export interface FloorReading {
  layout: 'wide' | 'narrow';
  current: number;
  total: number;
}

/**
 * §4.3: the wide timeline shows `current / total`; the narrow progress widget holds three spans
 * of which the 1st and 3rd are current and total. Null when neither renders a pair of numbers.
 */
export function parseFloorCounter(root: DomRoot): FloorReading | null {
  const wide = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(text(root.querySelector(SELECTORS.floorWide)));
  if (wide) return { layout: 'wide', current: toInt(wide[1])!, total: toInt(wide[2])! };
  const spans = Array.from(root.querySelectorAll(SELECTORS.floorNarrow));
  const current = toInt(spans[0]?.textContent);
  const total = toInt(spans[2]?.textContent);
  if (spans.length >= 3 && current !== null && total !== null) return { layout: 'narrow', current, total };
  return null;
}

/** A03 marker counts within `root`: the reactions container and, as second evidence, the liked icon. */
export function likedMarkers(root: DomRoot): { reacted: number; likedIcon: number } {
  return {
    reacted: root.querySelectorAll(SELECTORS.likedReacted).length,
    likedIcon: root.querySelectorAll(SELECTORS.likedIcon).length,
  };
}

/** A03: a floor showing either marker is already liked, and its like button must not be pressed. */
export function isLiked(post: DomRoot): boolean {
  const m = likedMarkers(post);
  return m.reacted > 0 || m.likedIcon > 0;
}

/** A06: which of the editor selector sets the open composer exposes. */
export function editorKind(root: DomRoot): 'textarea' | 'd-editor-input' | 'prosemirror' | null {
  if (root.querySelector(SELECTORS.replyTextarea)) return 'textarea';
  if (root.querySelector(SELECTORS.replyEditor)) return 'd-editor-input';
  if (root.querySelector('#reply-control .ProseMirror, #reply-control [contenteditable="true"]')) return 'prosemirror';
  return null;
}

export interface CategoryLink {
  name: string;
  path: string;
  id: number;
}

/**
 * The name inside a category link. Only the link's own name element counts: the enclosing block
 * belongs to the parent category, and the link's whole text runs icon, name and description
 * together on docofcard.
 */
function categoryName(a: Element): string {
  for (const sel of CATEGORY_NAME_SELECTORS) {
    const name = text(a.querySelector(sel));
    if (name) return name;
  }
  return '';
}

/**
 * Category entries on the `/categories` page (§7.1, Appendix A): slug and id from `a[href]`
 * matching `/c/<slug>/<id>`, the name from the category name element inside the link. Links without
 * one, such as category badges on topic rows or subcategory badges, are not entries.
 */
export function categoryLinks(root: DomRoot, baseUrl: string): CategoryLink[] {
  const seen = new Map<number, CategoryLink>();
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    let path: string;
    try {
      const url = new URL(a.getAttribute('href') ?? '', baseUrl);
      if (url.origin !== new URL(baseUrl).origin) continue;
      path = url.pathname.replace(/\/$/, '');
    } catch {
      continue;
    }
    const m = CATEGORY_PATH.exec(path);
    if (!m) continue;
    const id = Number(m[2]);
    const name = categoryName(a);
    if (name && !seen.has(id)) seen.set(id, { name, path, id });
  }
  return [...seen.values()];
}
