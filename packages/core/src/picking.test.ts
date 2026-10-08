import { describe, expect, it } from 'vitest';
import { sampleTopics, selectCandidates } from './picking';
import { seededRandom } from './runtime';
import type { TopicCandidate } from './terms';

const row = (id: string, unread: boolean, pinned = false): TopicCandidate => ({ id, title: `t${id}`, unread, pinned });

describe('PICK-001 three-segment candidate selection (T04, T06)', () => {
  it('uses only unread topics when at least three are unread', () => {
    const rows = [row('1', true), row('2', false), row('3', true), row('4', true), row('5', false)];
    expect(selectCandidates(rows, seededRandom(1)).map((t) => t.id)).toEqual(['1', '3', '4']);
  });

  it('tops up fewer than three unread topics with at most three read ones', () => {
    const rows = [row('u1', true), ...['a', 'b', 'c', 'd', 'e'].map((id) => row(id, false))];
    for (let seed = 1; seed <= 50; seed++) {
      const picked = selectCandidates(rows, seededRandom(seed));
      expect(picked[0]?.id).toBe('u1');
      expect(picked).toHaveLength(4);
      expect(picked.slice(1).every((t) => !t.unread)).toBe(true);
      expect(new Set(picked.map((t) => t.id)).size).toBe(4);
    }
    const fewRead = [row('u1', true), row('u2', true), row('r1', false)];
    expect(selectCandidates(fewRead, seededRandom(1)).map((t) => t.id)).toEqual(['u1', 'u2', 'r1']);
  });

  it('falls back to read topics when nothing is unread', () => {
    const rows = [row('1', false), row('2', false)];
    expect(selectCandidates(rows, seededRandom(1)).map((t) => t.id)).toEqual(['1', '2']);
  });

  it('never selects pinned topics, unread or not', () => {
    const rows = [row('p1', true, true), row('p2', false, true), row('1', true), row('2', false)];
    for (let seed = 1; seed <= 20; seed++) {
      expect(selectCandidates(rows, seededRandom(seed)).some((t) => t.pinned)).toBe(false);
    }
    expect(selectCandidates([row('p', true, true)], seededRandom(1))).toEqual([]);
  });
});

describe('PICK-002 per-category sampling (T07)', () => {
  const pool = Array.from({ length: 30 }, (_, i) => i);

  it('draws between 3 and 8 topics and covers the whole range across seeds', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 500; seed++) {
      const picked = sampleTopics(pool, seededRandom(seed));
      expect(picked.length).toBeGreaterThanOrEqual(3);
      expect(picked.length).toBeLessThanOrEqual(8);
      expect(new Set(picked).size).toBe(picked.length);
      seen.add(picked.length);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('is reproducible for a fixed seed', () => {
    expect(sampleTopics(pool, seededRandom(42))).toEqual(sampleTopics(pool, seededRandom(42)));
  });

  it('takes every candidate when there are fewer than drawn', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(sampleTopics([1, 2], seededRandom(seed)).sort()).toEqual([1, 2]);
    }
    expect(sampleTopics([], seededRandom(1))).toEqual([]);
  });
});
