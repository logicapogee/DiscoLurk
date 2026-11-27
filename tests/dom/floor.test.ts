import { SELECTORS, floorCounterFromText, parseFloorCounter } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, count, fixture, textOf, type SiteId } from './fixtures';

/** The captured topic for each site: wide and narrow floor readings of the long topic. */
const TOPIC: Readonly<Record<SiteId, { wide: number; narrow: number; total: number }>> = {
  linuxdo: { wide: 4, narrow: 4, total: 6485 },
  docofcard: { wide: 468, narrow: 467, total: 478 },
};

describe.each(SITE_IDS)('FLOOR-001 floor counter in both layouts (§4.3, F02) — %s', (site) => {
  const wide = fixture(site, 'topic-wide.html');
  const narrow = fixture(site, 'topic-narrow.html');

  it('reads `current / total` from .timeline-replies on the wide layout', () => {
    expect(count(wide, SELECTORS.floorWide)).toBe(1);
    expect(textOf(wide.querySelector(SELECTORS.floorWide))).toMatch(/^\d[\d,]*\s*\/\s*\d[\d,]*$/);
    expect(parseFloorCounter(wide)).toEqual({ layout: 'wide', current: TOPIC[site].wide, total: TOPIC[site].total });
  });

  it('reads the 1st and 3rd of the three #topic-progress .nums spans on the narrow layout', () => {
    expect(count(narrow, SELECTORS.floorWide)).toBe(0);
    const spans = Array.from(narrow.querySelectorAll(SELECTORS.floorNarrow)).map(textOf);
    expect(spans).toEqual([String(TOPIC[site].narrow), '/', String(TOPIC[site].total)]);
    expect(parseFloorCounter(narrow)).toEqual({ layout: 'narrow', current: TOPIC[site].narrow, total: TOPIC[site].total });
  });

  it('reports the same total in both layouts', () => {
    expect(parseFloorCounter(narrow)?.total).toBe(parseFloorCounter(wide)?.total);
  });

  it('reads the same values from the counters\' text alone, as the live page hands them over', () => {
    for (const doc of [wide, narrow]) {
      const wideText = doc.querySelector(SELECTORS.floorWide);
      const narrowTexts = Array.from(doc.querySelectorAll(SELECTORS.floorNarrow)).map(textOf);
      expect(floorCounterFromText(wideText ? textOf(wideText) : null, narrowTexts)).toEqual(parseFloorCounter(doc));
    }
  });

  it('returns null when neither counter is rendered (F08)', () => {
    expect(parseFloorCounter(fixture(site, 'list.html'))).toBeNull();
  });
});
