import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '@disco-lurk/site-discourse';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

export type SiteId = 'linuxdo' | 'docofcard';

export const SITE_IDS: readonly SiteId[] = ['linuxdo', 'docofcard'];

export const BASE_URL: Readonly<Record<SiteId, string>> = {
  linuxdo: 'https://linux.do',
  docofcard: 'https://forum.docofcard.com',
};

const cache = new Map<string, Document>();

/** Parsed once per file: the fixtures are several hundred KB each and every test only reads them. */
export function fixture(site: SiteId, file: string): Document {
  const key = `${site}/${file}`;
  let doc = cache.get(key);
  if (!doc) {
    doc = parseDocument(readFileSync(fixturesDir + key, 'utf8'));
    cache.set(key, doc);
  }
  return doc;
}

export const count = (root: ParentNode, selector: string) => root.querySelectorAll(selector).length;

export const textOf = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
