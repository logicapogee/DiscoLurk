import { SELECTORS, editorKind } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture, type SiteId } from './fixtures';

/** Appendix A: linuxdo renders a plain textarea, docofcard a ProseMirror div carrying `.d-editor-input`. */
const EDITOR: Readonly<Record<SiteId, { selector: string; kind: ReturnType<typeof editorKind> }>> = {
  linuxdo: { selector: SELECTORS.replyTextarea, kind: 'textarea' },
  docofcard: { selector: SELECTORS.replyEditor, kind: 'd-editor-input' },
};

describe.each(SITE_IDS)('EDITOR-001 reply composer selectors (A06) — %s', (site) => {
  const doc = fixture(site, 'reply-editor.html');

  it(`hits the site's editor selector`, () => {
    expect(count(doc, EDITOR[site].selector)).toBe(1);
    expect(editorKind(doc)).toBe(EDITOR[site].kind);
  });

  it('has the open and submit buttons', () => {
    expect(count(doc, SELECTORS.replyOpen)).toBe(1);
    expect(count(doc, SELECTORS.replySubmit)).toBe(1);
  });

  it('finds no composer on a page where it is closed', () => {
    expect(editorKind(fixture(site, 'topic-wide.html'))).toBeNull();
  });
});
