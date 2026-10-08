import { describe, expect, it } from 'vitest';
import type { FloorAdvance, ReadStrategy } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import type { FloorReading } from './parse';
import { DEEP, QUICK, readFloors, type FloorSurface } from './reading';

/**
 * A topic page whose counter follows the scroll offset: one floor per `pxPerFloor`, capped at
 * `total`. `renderAfterMs` delays the counter's first appearance; `frozen` never moves it.
 */
function topic(
  time: VirtualTime,
  opts: { total: number; pxPerFloor?: number; renderAfterMs?: number; frozen?: boolean; counter?: boolean; posts?: number; floorEvery?: number },
) {
  let offset = 0;
  const scrolls: number[] = [];
  const surface: FloorSurface = {
    async whenVisible() {},
    async readCounter(): Promise<FloorReading | null> {
      if (opts.counter === false || time.clock.monotonic() < (opts.renderAfterMs ?? 0)) return null;
      const climbed = opts.floorEvery ? Math.floor(scrolls.length / opts.floorEvery) : Math.floor(offset / (opts.pxPerFloor ?? 300));
      const current = opts.frozen ? 1 : Math.min(opts.total, 1 + climbed);
      return { layout: 'wide', current, total: opts.total };
    },
    async countPosts() {
      return opts.posts ?? 0;
    },
    async scroll(dy) {
      scrolls.push(dy);
      offset += dy;
    },
  };
  return { surface, scrolls };
}

function strategy(browseMode: 'deep' | 'quick', stopAt = Infinity) {
  const advances: FloorAdvance[] = [];
  let confirmed = 0;
  const s: ReadStrategy = {
    browseMode,
    onFloor(a) {
      advances.push(a);
      if (a.confirmed) confirmed += a.to - a.from;
      return confirmed >= stopAt ? 'stop' : 'continue';
    },
  };
  return { s, advances };
}

const read = (time: VirtualTime, surface: FloorSurface, s: ReadStrategy, signal = new AbortController().signal) =>
  time.drive(readFloors(surface, s, time.deps(5), signal));

describe('FLOOR-000 counter first (F01)', () => {
  it('waits for a late counter instead of falling back to blind scrolling', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 50, renderAfterMs: 2_000 });
    const { s, advances } = strategy('deep', 5);
    const out = await read(time, surface, s);
    expect(out.startFloor).toBe(1);
    expect(advances.every((a) => a.confirmed)).toBe(true);
    expect(scrolls[0]).toBeGreaterThanOrEqual(DEEP.stepPx[0]);
  });
});

describe('FLOOR-002 delta accounting (F02, F03)', () => {
  it('adds only the climb between consecutive readings and never the current floor twice', async () => {
    const time = new VirtualTime();
    const { surface } = topic(time, { total: 40 });
    const { s, advances } = strategy('deep');
    const out = await read(time, surface, s);
    const total = advances.reduce((n, a) => n + a.to - a.from, 0);
    expect(total).toBe((out.endFloor ?? 0) - (out.startFloor ?? 0));
    expect(out.endFloor).toBe(40);
    for (let i = 1; i < advances.length; i++) expect(advances[i]!.from).toBe(advances[i - 1]!.to);
  });

  it('scrolls 600–1200 px per step', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 500, pxPerFloor: 100 });
    await read(time, surface, strategy('deep', 30).s);
    for (const dy of scrolls) expect(dy === DEEP.bigStepPx || (dy >= 600 && dy <= 1200)).toBe(true);
  });
});

const normalStep = (dy: number) => dy >= DEEP.stepPx[0] && dy <= DEEP.stepPx[1];

describe('FLOOR-003 stuck counter (F04)', () => {
  it('takes one 1500 px step after three readings without progress', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 100, frozen: true });
    await read(time, surface, strategy('deep').s);
    expect(scrolls.slice(0, 4).map((dy, i) => (i === 3 ? dy : normalStep(dy)))).toEqual([true, true, true, DEEP.bigStepPx]);
  });

  it('ends the topic when three more readings after the big step still show no progress', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 100, frozen: true });
    const out = await read(time, surface, strategy('deep').s);
    expect(scrolls.map((dy) => (dy === DEEP.bigStepPx ? 'big' : normalStep(dy)))).toEqual([true, true, true, 'big', true, true, true]);
    expect(out.scrolls).toBe(2 * DEEP.stuckLimit + 1);
  });

  it('a counter that moves again resets the stall, so a later stall gets its own big step', async () => {
    const time = new VirtualTime();
    // Floor 2 appears with the big step; afterwards the counter freezes again.
    let scrolled = 0;
    const surface = {
      async readCounter() {
        return { layout: 'wide' as const, current: scrolled >= 4 ? 2 : 1, total: 100 };
      },
      async whenVisible() {},
      async countPosts() {
        return 0;
      },
      async scroll() {
        scrolled++;
      },
    };
    const out = await read(time, surface, strategy('deep').s);
    expect(out.endFloor).toBe(2);
    // 3 stuck + big (advances) + 3 stuck + big + 3 stuck.
    expect(out.scrolls).toBe(11);
  });
});

describe('FLOOR-004 hard stop (F05)', () => {
  it('never scrolls a topic more than 200 times', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 10_000, floorEvery: 2 });
    const out = await read(time, surface, strategy('deep').s);
    expect(scrolls).toHaveLength(DEEP.maxScrolls);
    expect(out.scrolls).toBe(DEEP.maxScrolls);
  });
});

describe('FLOOR-005 traditional scrolling (F07, F08)', () => {
  it('reads short topics with gentle steps for 8–15 s and counts the counter delta as confirmed', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 6, pxPerFloor: 200 });
    const { s, advances } = strategy('deep');
    const out = await read(time, surface, s);
    for (const dy of scrolls) expect(dy >= 150 && dy <= 400).toBe(true);
    expect(advances.every((a) => a.confirmed)).toBe(true);
    expect(advances.reduce((n, a) => n + a.to - a.from, 0)).toBe((out.endFloor ?? 0) - 1);
  });

  it('without any counter credits one estimated floor however long it scrolls', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 1, counter: false });
    const { s, advances } = strategy('deep');
    const out = await read(time, surface, s);
    expect(scrolls.length).toBeGreaterThan(1);
    expect(advances).toEqual([{ from: 0, to: 1, confirmed: false }]);
    expect(out.layout).toBeNull();
  });

  it('without any counter credits the rendered posts when they can be counted', async () => {
    const time = new VirtualTime();
    const { surface } = topic(time, { total: 1, counter: false, posts: 4 });
    const { s, advances } = strategy('deep');
    await read(time, surface, s);
    expect(advances).toEqual([{ from: 0, to: 4, confirmed: false }]);
  });
});

describe('STOP-001 target met mid-topic (F06)', () => {
  it('stops scrolling as soon as onFloor returns stop', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 1000 });
    const out = await read(time, surface, strategy('deep', 3).s);
    expect(out.stoppedByTarget).toBe(true);
    expect(scrolls.length).toBeLessThan(10);
  });
});

describe('QUICK-001 quick reading (Q01–Q03)', () => {
  it('moves on after 3–5 confirmed floors', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const time = new VirtualTime();
      const { surface } = topic(time, { total: 200, pxPerFloor: 500 });
      const { s, advances } = strategy('quick');
      const out = await time.drive(readFloors(surface, s, time.deps(seed), new AbortController().signal));
      const climbed = (out.endFloor ?? 0) - (out.startFloor ?? 0);
      expect(climbed).toBeGreaterThanOrEqual(3);
      expect(climbed).toBeLessThanOrEqual(5 + 1);
      expect(advances.every((a) => a.confirmed)).toBe(true);
    }
  });

  it('gives up after 10 scrolls with 400–800 px steps', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 200, frozen: true });
    await read(time, surface, strategy('quick').s);
    expect(scrolls).toHaveLength(QUICK.maxScrolls);
    for (const dy of scrolls) expect(dy >= 400 && dy <= 800).toBe(true);
  });
});

describe('QUICK-002 quick without a counter (Q04)', () => {
  it('blind-scrolls at most 3 times and credits one estimated floor, not one per scroll', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 1, counter: false });
    const { s, advances } = strategy('quick');
    await read(time, surface, s);
    expect(scrolls).toHaveLength(QUICK.blindScrolls);
    expect(advances).toEqual([{ from: 0, to: 1, confirmed: false }]);
  });

  it('a stop interrupts blind scrolling at once', async () => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 50, counter: false });
    const controller = new AbortController();
    time.at(7_000, () => controller.abort());
    await expect(read(time, surface, strategy('quick').s, controller.signal)).rejects.toThrow(/abort/i);
    expect(scrolls.length).toBeLessThan(QUICK.blindScrolls);
  });
});

describe('VIS-001 reading waits for a visible page before every dwell (I6)', () => {
  it.each(['deep', 'quick'] as const)('%s: no scroll happens while the page is hidden', async (mode) => {
    const time = new VirtualTime();
    const { surface, scrolls } = topic(time, { total: 40 });
    const visibleAt = 20_000;
    let checks = 0;
    surface.whenVisible = async (signal) => {
      checks++;
      while (time.clock.monotonic() < visibleAt) await time.sleeper.sleep(2_000, signal);
    };
    const scrolledAt: number[] = [];
    const scroll = surface.scroll.bind(surface);
    surface.scroll = async (dy) => {
      scrolledAt.push(time.clock.monotonic());
      await scroll(dy);
    };
    await read(time, surface, strategy(mode, 3).s);
    expect(scrolls.length).toBeGreaterThan(0);
    expect(Math.min(...scrolledAt)).toBeGreaterThanOrEqual(visibleAt);
    expect(checks).toBe(scrolls.length);
  });
});
