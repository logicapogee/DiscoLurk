import { EDITOR_SELECTORS, SELECTORS, editorKind } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture, type SiteId } from './fixtures';

/**
 * Appendix A: linuxdo renders a plain textarea (also classed `.d-editor-input`), docofcard a
 * ProseMirror div carrying `.d-editor-input`; ProseMirror is tried first, the textarea last.
 */
const EDITOR: Readonly<Record<SiteId, { selector: string; kind: ReturnType<typeof editorKind> }>> = {
  linuxdo: { selector: SELECTORS.replyTextarea, kind: 'textarea' },
  docofcard: { selector: EDITOR_SELECTORS.prosemirror, kind: 'prosemirror' },
};

describe.each(SITE_IDS)('EDITOR-001 reply composer selectors (A06) — %s', (site) => {
  const doc = fixture(site, 'reply-editor.html');

  it(`hits the site's editor selector`, () => {
    expect(count(doc, EDITOR[site].selector)).toBe(1);
    expect(editorKind(doc)).toBe(EDITOR[site].kind);
  });

  it('lets the detection order decide: linuxdo matches the textarea only, docofcard ProseMirror before .d-editor-input', () => {
    const hits = Object.entries(EDITOR_SELECTORS)
      .filter(([, selector]) => count(doc, selector) > 0)
      .map(([kind]) => kind);
    expect(hits).toEqual(site === 'linuxdo' ? ['textarea'] : ['prosemirror', 'd-editor-input']);
  });

  it('has the open and submit buttons', () => {
    expect(count(doc, SELECTORS.replyOpen)).toBe(1);
    expect(count(doc, SELECTORS.replySubmit)).toBe(1);
  });

  it('finds no composer on a page where it is closed', () => {
    expect(editorKind(fixture(site, 'topic-wide.html'))).toBeNull();
  });
});
