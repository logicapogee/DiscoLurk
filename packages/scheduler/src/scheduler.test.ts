import { seededRandom } from '@disco-lurk/core';
import { describe, expect, it } from 'vitest';
import { describeSchedulerContract, TZ } from './contract';
import { dailyPoints } from './daily';
import { MemoryScheduleStore } from './store';
import { localParts, zonedToEpoch } from './tz';

describe('daily-window points', () => {
  it('stay inside the window, keep the minimum gap, and only use the part of the day still ahead', () => {
    const w = { runs: 4, start: 420, end: 1380, jitterMinutes: 15, minGapMinutes: 90 };
    for (let seed = 1; seed <= 200; seed++) {
      const pts = dailyPoints(w, 0, seededRandom(seed));
      expect(pts).toHaveLength(4);
      pts.forEach((p, i) => {
        expect(p).toBeGreaterThanOrEqual(420);
        expect(p).toBeLessThanOrEqual(1380);
        if (i > 0) expect(p - pts[i - 1]!).toBeGreaterThanOrEqual(90);
      });
      expect(dailyPoints(w, 900, seededRandom(seed)).every((p) => p >= 900)).toBe(true);
    }
    expect(dailyPoints(w, 1381, seededRandom(1))).toEqual([]);
  });

  it('resolve local wall time in the schedule zone', () => {
    const ms = zonedToEpoch('2026-10-08', 7 * 60, TZ);
    expect(new Date(ms).toISOString()).toBe('2026-10-07T23:00:00.000Z');
    expect(localParts(ms, TZ)).toEqual({ date: '2026-10-08', minutes: 420 });
    expect(new Date(zonedToEpoch('2026-03-08', 150, 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});

describeSchedulerContract('MemoryScheduleStore', () => {
  const cell = { data: null };
  return () => new MemoryScheduleStore(cell);
});
