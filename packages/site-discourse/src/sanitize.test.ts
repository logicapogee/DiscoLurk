import { describe, expect, it } from 'vitest';
import { parseDocument, parseTopicList } from './parse';
import { findLeaks, hostLabels, sanitizeHtml, scrubWith } from './sanitize';

const PAGE = `<!DOCTYPE html><html><head>
<meta name="csrf-token" content="SECRET-CSRF">
<meta id="data-preloaded" data-preloaded='{"currentUser":"{\\"username\\":\\"alice\\"}"}'>
<script>document.cookie = "_t=SECRET-COOKIE"</script>
</head><body>
<div id="current-user"><img class="avatar" src="https://cdn.example/user_avatar/linux.do/alice/48/1.png" srcset="https://cdn.example/user_avatar/linux.do/alice/96/1.png 2x"></div>
<table><tbody>
<tr class="topic-list-item pinned" data-topic-id="7"><td><a class="title raw-link raw-topic-link" href="/t/alice-notes/7">Notes by alice</a>
<a href="/u/bob" data-user-card="bob"><img class="avatar" title="bob" src="/letter_avatar_proxy/v4/letter/b/1.png"></a>
<span class="badge badge-notification new-topic"></span></td></tr>
</tbody></table>
<article data-post-number="1"><span class="full-name">Robert Smith</span><p>mail me: bob@mail.example.com, @alice</p></article>
<input id="login-account-name" value="alice">
</body></html>`;

describe('fixture sanitizing (§11.2)', () => {
  const { html, mapping } = sanitizeHtml(PAGE, ['alice']);

  it('removes usernames, display names, avatars, emails, form values, CSRF and cookies', () => {
    expect(findLeaks(html, ['alice', 'bob', 'Robert Smith'])).toEqual([]);
    for (const secret of ['SECRET-CSRF', 'SECRET-COOKIE', 'user_avatar', 'letter_avatar', 'mail.example.com']) {
      expect(html).not.toContain(secret);
    }
    expect(html).toContain('/u/user2');
    expect(html).toContain('@user1');
    expect(mapping.get('Robert Smith')).toBe('User 1');
  });

  it('keeps the structure selectors and parsers rely on', () => {
    const rows = parseTopicList(parseDocument(html));
    expect(rows).toEqual([{ id: '7', title: 'Notes by user1', pinned: true, unread: true, unreadPosts: false, hasTitleLink: true }]);
    expect(html).toContain('href="/t/user1-notes/7"');
    expect(html).toContain('id="current-user"');
  });

  it('scrubs accompanying text with the same aliases', () => {
    expect(scrubWith(mapping, 'https://forum.example/u/alice/trust-level')).toBe('https://forum.example/u/user1/trust-level');
  });

  it('keeps a site account named after the site host so absolute links stay on that host', () => {
    const page = '<html><body><a href="https://forum.docofcard.com/u/docofcard" data-user-card="docofcard">docofcard</a> <a href="https://forum.docofcard.com/c/bank/6">x</a></body></html>';
    const out = sanitizeHtml(page, [], hostLabels('https://forum.docofcard.com')).html;
    expect(out).toContain('https://forum.docofcard.com/c/bank/6');
    expect(out).not.toContain('user1');
  });
});
