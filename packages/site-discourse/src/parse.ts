import { parseHTML } from 'linkedom';
import { CATEGORY_NAME_SELECTORS, CATEGORY_PATH, EDITOR_SELECTORS, REPLIES_CELL, SELECTORS } from './selectors';

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
  /** Only the `new-topic` badge marks a never-visited topic. */
  unread: boolean;
  unreadPosts: boolean;
  hasTitleLink: boolean;
  /** Null when the row shows no readable reply count. */
  replies: number | null;
}

/** A list count such as `57`, `1,234`, `1.2k` or `3.4万`. */
export function abbreviatedCount(raw: string): number | null {
  const m = /(\d[\d.,]*)\s*([kKmM万])?/.exec(raw.trim());
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = m[2]?.toLowerCase();
  return Math.round(base * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === '万' ? 10_000 : 1));
}

/** Rows of a topic list with what candidate picking needs from each. */
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
      replies: abbreviatedCount(text(row.querySelector(REPLIES_CELL))),
    };
  });
}

export interface FloorReading {
  layout: 'wide' | 'narrow';
  current: number;
  total: number;
}

/**
 * The floor counter from its text: the wide timeline shows `current / total`; the narrow progress
 * widget holds three spans of which the 1st and 3rd are current and total. Null when neither
 * renders a pair of numbers.
 */
export function floorCounterFromText(wide: string | null, narrow: readonly string[]): FloorReading | null {
  const pair = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(wide ?? '');
  if (pair) return { layout: 'wide', current: toInt(pair[1])!, total: toInt(pair[2])! };
  const current = toInt(narrow[0]);
  const total = toInt(narrow[2]);
  if (narrow.length >= 3 && current !== null && total !== null) return { layout: 'narrow', current, total };
  return null;
}

export function parseFloorCounter(root: DomRoot): FloorReading | null {
  const wide = root.querySelector(SELECTORS.floorWide);
  return floorCounterFromText(wide ? text(wide) : null, Array.from(root.querySelectorAll(SELECTORS.floorNarrow)).map(text));
}

/** Liked-marker counts within `root`: the reactions container and, as second evidence, the liked icon. */
export function likedMarkers(root: DomRoot): { reacted: number; likedIcon: number } {
  return {
    reacted: root.querySelectorAll(SELECTORS.likedReacted).length,
    likedIcon: root.querySelectorAll(SELECTORS.likedIcon).length,
  };
}

/** A floor showing either marker is already liked, and its like button must not be pressed. */
export function isLiked(post: DomRoot): boolean {
  const m = likedMarkers(post);
  return m.reacted > 0 || m.likedIcon > 0;
}

export type EditorKind = keyof typeof EDITOR_SELECTORS;

/** Which of the editor selector sets the open composer exposes, from counts per set. */
export function editorKindFromCounts(counts: Readonly<Record<EditorKind, number>>): EditorKind | null {
  for (const kind of Object.keys(EDITOR_SELECTORS) as EditorKind[]) if (counts[kind] > 0) return kind;
  return null;
}

export function editorKind(root: DomRoot): EditorKind | null {
  const count = (kind: EditorKind) => root.querySelectorAll(EDITOR_SELECTORS[kind]).length;
  return editorKindFromCounts({ textarea: count('textarea'), 'd-editor-input': count('d-editor-input'), prosemirror: count('prosemirror') });
}

/**
 * The floors and topic time of one `/topics/timings` request body. Discourse posts it form-encoded
 * (`timings[<post>]=<ms>&topic_time=<ms>&topic_id=<id>`); a JSON body of the same shape is read too.
 */
export function parseTimingsBody(body: string | null): { topicId: string; postNumbers: number[]; topicMs: number } | null {
  if (!body) return null;
  let timings: Record<string, unknown> = {};
  let topicId: unknown;
  let topicTime: unknown;
  if (body.trimStart().startsWith('{')) {
    try {
      const json = JSON.parse(body) as { timings?: Record<string, unknown>; topic_id?: unknown; topic_time?: unknown };
      timings = json.timings ?? {};
      topicId = json.topic_id;
      topicTime = json.topic_time;
    } catch {
      return null;
    }
  } else {
    const form = new URLSearchParams(body);
    for (const [key, value] of form) {
      const m = /^timings\[(\d+)\]$/.exec(key);
      if (m) timings[m[1]!] = value;
    }
    topicId = form.get('topic_id');
    topicTime = form.get('topic_time');
  }
  const id = topicId === null || topicId === undefined ? '' : String(topicId);
  if (!/^\d+$/.test(id)) return null;
  const postNumbers = Object.keys(timings)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  const ms = Number(topicTime);
  return { topicId: id, postNumbers, topicMs: Number.isFinite(ms) && ms > 0 ? ms : 0 };
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
 * Category entries on the `/categories` page: slug and id from `a[href]`
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
