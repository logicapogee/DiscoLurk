import { validateReplyTemplates } from '@disco-lurk/config';
import { describe, expect, it } from 'vitest';
import { readData } from './data';

describe('TPL-001 reply templates (§4.5)', () => {
  it('data/reply-templates.json is non-empty, ≥ 6 characters each, and free of duplicates', () => {
    const file = readData('reply-templates.json') as { templates: string[] };
    expect(validateReplyTemplates(file.templates)).toEqual([]);
  });

  it('rejects short, blank, duplicate and empty sets', () => {
    expect(validateReplyTemplates(['感谢分享！'])).toHaveLength(1);
    expect(validateReplyTemplates(['      '])).toHaveLength(1);
    expect(validateReplyTemplates(['感谢分享，学到了', ' 感谢分享，学到了 '])).toHaveLength(1);
    expect(validateReplyTemplates([])).toEqual(['no templates']);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(validateReplyTemplates(['好帖👍👍👍👍'])).toEqual([]);
    expect(validateReplyTemplates(['👍👍👍👍👍'])).toHaveLength(1);
  });
});
