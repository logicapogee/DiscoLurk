/**
 * Appendix A, verbatim. Both built-in sites share these; a per-site difference found in Phase 0
 * belongs in `Site`, not in a second copy of this table.
 */
export const SELECTORS = {
  currentUser: '#current-user',
  loginUsername: '#login-account-name',
  loginPassword: '#login-account-password',
  loginButton: '#login-button',
  topicRow: 'tr.topic-list-item[data-topic-id]',
  pinnedRow: 'tr.pinned',
  topicLink: 'a.title.raw-link.raw-topic-link',
  newTopicBadge: '.badge.badge-notification.new-topic',
  unreadPostsBadge: '.badge-notification.unread-posts',
  floorWide: '.timeline-replies',
  floorNarrow: '#topic-progress .nums span',
  firstPost: '.topic-post[data-post-number="1"]',
  /** A cross-check only: once a long topic cloaks floor 1 this is an empty `div.post-stream--cloaked` (A04). */
  firstPostById: '#post_1',
  likeButton: 'button.btn-toggle-reaction-like',
  likedReacted: '.discourse-reactions-actions.has-reacted',
  likedIcon: 'button.btn-toggle-reaction-like .d-icon-d-liked',
  replyOpen: '.topic-footer-main-buttons button.create',
  replyTextarea: '#reply-control textarea',
  replyEditor: '.d-editor-input',
  replySubmit: '#reply-control button.create',
} as const;

export type SelectorName = keyof typeof SELECTORS;

/** §4.5: diagnostic fallbacks only; production clicks use `SELECTORS.likeButton`. */
export const LIKE_FALLBACK_SELECTORS = [
  '.discourse-reactions-reaction-button button',
  'button[title="点赞此帖子"]',
  '.post-menu-area button.reaction-button',
] as const;

/** T02: deep mode opens a category already sorted by reply count; no header button is clicked. */
export const SORTED_BY_POSTS_QUERY = 'order=posts';

/**
 * Category name on the `/categories` page. Appendix A names `.category-name`; docofcard's
 * category-box layout has none and carries the name in its box heading instead.
 */
export const CATEGORY_NAME_SELECTORS = ['.category-name', '.category-box-heading h3'] as const;

/** Any link into a category; the `/categories` page has rendered once one exists. */
export const CATEGORY_LINK = 'a[href*="/c/"]';

/** Appendix A list URLs: `/c/<slug>/<id>` with optional parent slugs, plus the new/unread lists. */
export const CATEGORY_PATH = /^\/c\/((?:[^/?#]+\/)*[^/?#]+)\/(\d+)\/?$/;

export const rowSelector = (topicId: string) => `tr.topic-list-item[data-topic-id="${topicId}"]`;

/** T08: the topic URL shape that confirms entry. */
export const topicUrlPattern = (topicId: string) => new RegExp(`/t/[^/?#]+/${topicId}(?:[/?#]|$)`);

/**
 * Not Appendix A: signs that the site serves a challenge page instead of Discourse (B10, §1.3).
 * They are only reported, never interacted with.
 */
export const CHALLENGE_SELECTOR = '#challenge-form, #challenge-stage, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]';
export const CHALLENGE_TITLE = /just a moment|attention required|请稍候/i;

/** Not Appendix A: the header's sign-in button, which Discourse renders only for anonymous visitors. */
export const ANONYMOUS_HEADER = '.d-header .login-button';

/** §5.1: connect's progress page is ready once any of its four metric groups renders. */
export const CONNECT_READY = '.tl3-ring, .tl3-bar-item, .tl3-quota-card, .tl3-veto-item';
