/** A floor's container, addressed by post number so cloaking or DOM order cannot point it at another post. */
export const postOf = (postNumber: number) => `.topic-post[data-post-number="${postNumber}"]`;

/** Every rendered floor that carries its post number. */
export const POST_WITH_NUMBER = '.topic-post[data-post-number]';

/**
 * The design's selector table, verbatim. Both built-in sites share these; a per-site difference
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
  firstPost: postOf(1),
  /** A cross-check only: once a long topic cloaks floor 1 this is an empty `div.post-stream--cloaked`. */
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

/** Diagnostic fallbacks only; production clicks use `SELECTORS.likeButton`. */
export const LIKE_FALLBACK_SELECTORS = [
  '.discourse-reactions-reaction-button button',
  'button[title="点赞此帖子"]',
  '.post-menu-area button.reaction-button',
] as const;

/** Deep mode opens a category already sorted by reply count; no header button is clicked. */
export const SORTED_BY_POSTS_QUERY = 'order=posts';

/**
 * Category name on the `/categories` page. The selector table names `.category-name`; docofcard's
 * category-box layout has none and carries the name in its box heading instead.
 */
export const CATEGORY_NAME_SELECTORS = ['.category-name', '.category-box-heading h3'] as const;

/** Any link into a category; the `/categories` page has rendered once one exists. */
export const CATEGORY_LINK = 'a[href*="/c/"]';

/** List URLs: `/c/<slug>/<id>` with optional parent slugs, plus the new/unread lists. */
export const CATEGORY_PATH = /^\/c\/((?:[^/?#]+\/)*[^/?#]+)\/(\d+)\/?$/;

/** Not from the selector table: the footer Discourse renders under every topic list, empty or not. */
export const LIST_END = 'footer.topic-list-bottom';

/** Any rendered post of a topic; it marks entry when a one-floor topic shows no floor counter. */
export const TOPIC_POST = '.topic-post';

/** A post's like button, looked up inside its own floor. */
export const likeButtonOf = (postNumber: number) => `${postOf(postNumber)} ${SELECTORS.likeButton}`;

/** Either marker inside a floor means it is already liked: the reactions container, and the liked icon as second evidence. */
export const LIKED_MARKERS = [
  { name: 'reacted', selector: SELECTORS.likedReacted },
  { name: 'likedIcon', selector: SELECTORS.likedIcon },
] as const;

/** The unliked icon: the only positive evidence that a press adds a like instead of taking one back. */
export const UNLIKED_ICON = `${SELECTORS.likeButton} .d-icon-d-unliked`;

/** Not from the selector table: the reply count a list row shows (linuxdo's posts cell, docofcard's `gf-*` stat box). */
export const REPLIES_CELL = 'td.posts .number, .gf-stat-posts .gf-stat-number';

/**
 * Not from the selector table: the composer while it holds anything (open, or minimised to a draft),
 * its discard button, and the confirmation Discourse asks for before throwing a draft away.
 */
export const COMPOSER_OPEN = '#reply-control.open, #reply-control.draft';
export const COMPOSER_DISCARD = '#reply-control .discard-button';
export const COMPOSER_DISCARD_CONFIRM = '.discard-draft-modal .btn-danger';

/**
 * The editors the composer may show, in the order they are tried. docofcard's ProseMirror editor also
 * carries `.d-editor-input`, and linuxdo's textarea does too, so the plain `.d-editor-input` kind
 * covers only an element that is neither.
 */
export const EDITOR_SELECTORS = {
  prosemirror: '#reply-control div[contenteditable].ProseMirror, #reply-control .ProseMirror.d-editor-input',
  'd-editor-input': `#reply-control ${SELECTORS.replyEditor}:not(textarea)`,
  textarea: SELECTORS.replyTextarea,
} as const;

export const rowSelector = (topicId: string) => `tr.topic-list-item[data-topic-id="${topicId}"]`;

/** The topic URL shape that confirms entry. */
export const topicUrlPattern = (topicId: string) => new RegExp(`/t/[^/?#]+/${topicId}(?:[/?#]|$)`);

/**
 * Not from the selector table: signs that the site serves a challenge page instead of Discourse.
 * They are only reported, never interacted with.
 */
export const CHALLENGE_SELECTOR = '#challenge-form, #challenge-stage, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]';
export const CHALLENGE_TITLE = /just a moment|attention required|请稍候/i;

/** Not from the selector table: the header's sign-in button, which Discourse renders only for anonymous visitors. */
export const ANONYMOUS_HEADER = '.d-header .login-button';

/** Connect's progress page is ready once any of its four metric groups renders. */
export const CONNECT_READY = '.tl3-ring, .tl3-bar-item, .tl3-quota-card, .tl3-veto-item';

/**
 * Signs that connect shows its OAuth authorization page instead of the progress page. No
 * authorization page has been seen live (the fixture capture recorded `authorizePage: false`), so this
 * is a conservative guess: an authorize/OAuth address, or a form posting to an authorize endpoint.
 * The address is matched on its path only, because the progress page itself links to `/oauth2/log`.
 */
export const CONNECT_AUTHORIZE_FORM = 'form[action*="authorize"]';
export const CONNECT_AUTHORIZE_PATH = /\/(oauth|authorize)/i;
