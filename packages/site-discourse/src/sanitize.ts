import { parseDocument } from './parse';

const AVATAR_PLACEHOLDER = '/images/avatar-redacted.png';
const AVATAR_URL = /\/user_avatar\/|letter_avatar|\/avatars?\//i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const USER_PATH = /\/u\/([^/?#"'\s]+)/g;
/**
 * Only attributes that carry identity are rewritten: class, id and data-* hooks are what the
 * selectors match, and a username equal to a word like `posts` must not break them.
 */
const IDENTITY_ATTRS = new Set([
  'href', 'src', 'srcset', 'data-src', 'style', 'title', 'alt', 'aria-label', 'content',
  'data-user-card', 'data-username', 'data-tooltip', 'data-title', 'data-original-title',
]);
const DROP = [
  'script',
  'noscript',
  'style',
  'link[rel="preload"]',
  'link[rel="modulepreload"]',
  'link[rel="prefetch"]',
  'meta[name="csrf-token"]',
  'meta[name="csrf-param"]',
  '[data-preloaded]',
];

export interface SanitizeResult {
  html: string;
  /** Original → replacement, for scrubbing URLs and logs that accompany the fixture. */
  mapping: Map<string, string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Hyphens count as boundaries so a username inside a slug such as `notes-by-alice` is caught too. */
const nameRe = (name: string, flags: string) => new RegExp(`(?<![A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`, flags);

/**
 * Fixtures and diagnostics (§11.2) keep page structure but no identity: scripts and preloaded
 * data (which carry the current user and CSRF token) are dropped, avatars point to a placeholder,
 * emails and form values are cleared, and every username or display name found on the page is
 * replaced by a stable alias, together with `knownUsernames` the caller already holds. Names in
 * `keep` (the labels of the site's own host name) stay: a site account named after its domain would
 * otherwise turn every absolute link into another host.
 */
export function sanitizeHtml(html: string, knownUsernames: string[] = [], keep: string[] = []): SanitizeResult {
  const doc = parseDocument(html);
  for (const sel of DROP) for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();

  const usernames = new Set(knownUsernames.filter(Boolean));
  const displayNames = new Set<string>();
  const all = Array.from(doc.querySelectorAll('*'));
  for (const el of all) {
    for (const name of ['data-user-card', 'data-username']) {
      const v = el.getAttribute(name);
      if (v) usernames.add(v);
    }
    for (const name of ['href', 'src', 'srcset', 'data-src']) {
      for (const m of (el.getAttribute(name) ?? '').matchAll(USER_PATH)) usernames.add(decodeURIComponent(m[1]!));
      for (const m of (el.getAttribute(name) ?? '').matchAll(/\/user_avatar\/[^/]+\/([^/]+)\//g)) usernames.add(decodeURIComponent(m[1]!));
    }
  }
  for (const el of Array.from(doc.querySelectorAll('.full-name, .user-card-name'))) {
    const t = (el.textContent ?? '').trim();
    if (t.length >= 2) displayNames.add(t);
  }
  for (const u of usernames) displayNames.delete(u);
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  for (const u of [...usernames]) if (kept.has(u.toLowerCase())) usernames.delete(u);

  const mapping = new Map<string, string>();
  let n = 0;
  for (const u of [...usernames].sort()) mapping.set(u, `user${++n}`);
  n = 0;
  for (const d of [...displayNames].sort()) mapping.set(d, `User ${++n}`);
  const patterns = [...mapping.entries()]
    .filter(([from]) => from.length >= 2)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => [nameRe(from, 'gi'), to] as const);
  const scrub = (s: string) => patterns.reduce((acc, [re, to]) => acc.replace(re, to), s).replace(EMAIL, 'user@example.invalid');

  for (const el of all) {
    if (!el.isConnected) continue;
    if (el.tagName === 'INPUT' && !['submit', 'button', 'checkbox', 'radio'].includes((el.getAttribute('type') ?? 'text').toLowerCase())) {
      el.removeAttribute('value');
    }
    for (const attr of Array.from(el.attributes)) {
      if (!IDENTITY_ATTRS.has(attr.name)) continue;
      let v = attr.value;
      if (['src', 'srcset', 'data-src', 'href', 'style'].includes(attr.name) && AVATAR_URL.test(v)) {
        v = attr.name === 'style' ? v.replace(/url\([^)]*\)/g, `url(${AVATAR_PLACEHOLDER})`) : AVATAR_PLACEHOLDER;
      }
      v = scrub(v);
      if (v !== attr.value) el.setAttribute(attr.name, v);
    }
  }
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 8) {
        const v = child.nodeValue ?? '';
        const s = scrub(v);
        if (s !== v) child.nodeValue = s;
      } else walk(child);
    }
  };
  walk(doc);
  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, mapping };
}

/** Applies a fixture's alias mapping to text stored next to it, such as URLs in capture metadata. */
export function scrubWith(mapping: Map<string, string>, s: string): string {
  let out = s;
  for (const [from, to] of [...mapping.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(nameRe(from, 'gi'), to);
  }
  return out.replace(EMAIL, 'user@example.invalid');
}

/** Identity that survived sanitizing; a non-empty result means the fixture must not be committed. */
/** Labels of a site's host name, e.g. `forum`, `docofcard`, `com`; see `sanitizeHtml`'s `keep`. */
export const hostLabels = (baseUrl: string) => new URL(baseUrl).hostname.split(/[.-]/).filter(Boolean);

export function findLeaks(html: string, identities: string[]): string[] {
  const leaks = identities.filter((id) => id.length >= 2 && nameRe(id, 'i').test(html));
  const emails = html.match(EMAIL) ?? [];
  return [...leaks, ...emails.filter((e) => e !== 'user@example.invalid')];
}
