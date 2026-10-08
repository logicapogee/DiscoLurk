import { SELECTORS, isLiked, likedMarkers } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture } from './fixtures';

/** The floor the user liked by hand before capture (docs/PHASE0_REPORT.md). */
const LIKED_FLOOR = '2';

describe.each(SITE_IDS)('LIKE-001 liked-state detection (A03, A04) — %s', (site) => {
  const liked = fixture(site, 'liked.html');
  const floors = Array.from(liked.querySelectorAll('.topic-post[data-post-number]'));

  it('judges exactly the hand-liked floor as liked and every other floor as not liked', () => {
    expect(floors.length).toBeGreaterThan(1);
    const likedFloors = floors.filter((f) => isLiked(f)).map((f) => f.getAttribute('data-post-number'));
    expect(likedFloors).toEqual([LIKED_FLOOR]);
  });

  it('finds both A03 markers on the liked floor and neither elsewhere', () => {
    for (const f of floors) {
      const m = likedMarkers(f);
      if (f.getAttribute('data-post-number') === LIKED_FLOOR) {
        expect(m.reacted).toBeGreaterThan(0);
        expect(m.likedIcon).toBe(1);
      } else {
        expect(m).toEqual({ reacted: 0, likedIcon: 0 });
      }
    }
  });

  it('every floor still exposes the production like button', () => {
    for (const f of floors) expect(count(f, SELECTORS.likeButton)).toBe(1);
  });

  it.each(['.has-like', '.my-likes', '.has-used'])('carries no retired marker %s, so detection cannot rest on it', (marker) => {
    expect(count(liked, marker)).toBe(0);
  });

  it('finds floor 1 by data-post-number on a short topic', () => {
    expect(count(liked, SELECTORS.firstPost)).toBe(1);
  });

  it('loses floor 1 to cloaking on a long topic, leaving #post_1 as a hollow placeholder', () => {
    const wide = fixture(site, 'topic-wide.html');
    expect(count(wide, SELECTORS.firstPost)).toBe(0);
    const placeholder = wide.querySelector(SELECTORS.firstPostById);
    expect(placeholder).not.toBeNull();
    expect(placeholder!.matches('div.post-stream--cloaked')).toBe(true);
    expect(count(placeholder!, '.topic-post')).toBe(0);
    expect(count(placeholder!, SELECTORS.likeButton)).toBe(0);
  });
});
