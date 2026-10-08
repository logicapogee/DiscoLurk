import { SELECTORS, parseFloorCounter } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture, textOf, type SiteId } from './fixtures';

/** The captured topic for each site: floor 4 of the long topic used for the deep-read fixtures. */
const TOPIC: Readonly<Record<SiteId, { current: number; total: number }>> = {
  linuxdo: { current: 4, total: 6485 },
  docofcard: { current: 4, total: 478 },
};

describe.each(SITE_IDS)('FLOOR-001 floor counter in both layouts (§4.3, F02) — %s', (site) => {
  const wide = fixture(site, 'topic-wide.html');
  const narrow = fixture(site, 'topic-narrow.html');

  it('reads `current / total` from .timeline-replies on the wide layout', () => {
    expect(count(wide, SELECTORS.floorWide)).toBe(1);
    expect(textOf(wide.querySelector(SELECTORS.floorWide))).toMatch(/^\d[\d,]*\s*\/\s*\d[\d,]*$/);
    expect(parseFloorCounter(wide)).toEqual({ layout: 'wide', ...TOPIC[site] });
  });

  it('reads the 1st and 3rd of the three #topic-progress .nums spans on the narrow layout', () => {
    expect(count(narrow, SELECTORS.floorWide)).toBe(0);
    const spans = Array.from(narrow.querySelectorAll(SELECTORS.floorNarrow)).map(textOf);
    expect(spans).toEqual([String(TOPIC[site].current), '/', String(TOPIC[site].total)]);
    expect(parseFloorCounter(narrow)).toEqual({ layout: 'narrow', ...TOPIC[site] });
  });

  it('reports the same total in both layouts', () => {
    expect(parseFloorCounter(narrow)?.total).toBe(parseFloorCounter(wide)?.total);
  });

  it('returns null when neither counter is rendered (F08)', () => {
    expect(parseFloorCounter(fixture(site, 'list.html'))).toBeNull();
  });
});
