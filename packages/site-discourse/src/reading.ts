import { randomBetween, randomInt, type ReadResult, type ReadStrategy, type RuntimeDeps } from '@disco-lurk/core';
import type { FloorReading } from './parse';

/** The two things reading needs from a topic page; tests drive the strategies through a scripted one. */
export interface FloorSurface {
  readCounter(): Promise<FloorReading | null>;
  scroll(dy: number): Promise<void>;
}

/** Appendix B; every value is a field-tested default (I12), not a tuning knob. */
export const ENTRY_WAIT = { counterMs: 5_000, pollMs: 500, extraSec: [1, 3] } as const;
export const DEEP = {
  dwellSec: [2, 4],
  stepPx: [600, 1200],
  settleMs: 500,
  stuckLimit: 3,
  bigStepPx: 1500,
  bigSettleMs: 1_000,
  maxScrolls: 200,
  shortTopicFloors: 10,
} as const;
export const TRADITIONAL = { durationSec: [8, 15], stepPx: [150, 400], intervalSec: [1, 3] } as const;
export const QUICK = { floors: [3, 5], dwellSec: [1, 2], stepPx: [400, 800], settleMs: 300, maxScrolls: 10, blindScrolls: 3 } as const;

interface Tracker {
  result: ReadResult;
  last: number | null;
  /** Reports an advance; true when the strategy asked to stop (F06). */
  advance(reading: FloorReading): boolean;
  estimate(): boolean;
}

function tracker(start: FloorReading | null, strategy: ReadStrategy): Tracker {
  const t: Tracker = {
    result: { startFloor: start?.current ?? null, endFloor: start?.current ?? null, scrolls: 0, stoppedByTarget: false, layout: start?.layout ?? null },
    last: start?.current ?? null,
    advance(reading) {
      t.result.layout = reading.layout;
      if (t.last === null) {
        t.last = reading.current;
        t.result.startFloor ??= reading.current;
        t.result.endFloor = reading.current;
        return false;
      }
      // F02: only the climb between consecutive readings counts; a reading below the high-water mark adds nothing.
      if (reading.current <= t.last) return false;
      const verdict = strategy.onFloor({ from: t.last, to: reading.current, confirmed: true });
      t.last = reading.current;
      t.result.endFloor = reading.current;
      if (verdict === 'stop') t.result.stoppedByTarget = true;
      return verdict === 'stop';
    },
    estimate() {
      // F08 / Q04: without a counter one blind step stands for one floor, and it is never confirmed.
      const from = t.result.endFloor ?? 0;
      t.result.endFloor = from + 1;
      const verdict = strategy.onFloor({ from, to: from + 1, confirmed: false });
      if (verdict === 'stop') t.result.stoppedByTarget = true;
      return verdict === 'stop';
    },
  };
  return t;
}

/**
 * Reads a topic the way §4.3 (deep) or §4.4 (quick) prescribes. Every wait goes through the
 * injected sleeper, so a stop lands within one sleep (S05) and tests run on virtual time.
 */
export async function readFloors(surface: FloorSurface, strategy: ReadStrategy, deps: RuntimeDeps, signal: AbortSignal): Promise<ReadResult> {
  const sleep = (ms: number) => deps.sleeper.sleep(ms, signal);
  const pause = (range: readonly [number, number]) => sleep(randomBetween(deps.random, range[0], range[1]) * 1000);
  const px = (range: readonly [number, number]) => Math.round(randomBetween(deps.random, range[0], range[1]));

  // F01: a counter that has not rendered yet reads as null, which would wrongly fall back to blind scrolling.
  let first: FloorReading | null = null;
  for (let waited = 0; ; waited += ENTRY_WAIT.pollMs) {
    first = await surface.readCounter();
    if (first || waited >= ENTRY_WAIT.counterMs) break;
    await sleep(ENTRY_WAIT.pollMs);
  }
  await pause(ENTRY_WAIT.extraSec);
  first = (await surface.readCounter()) ?? first;

  const t = tracker(first, strategy);
  const scroll = async (dy: number) => {
    await surface.scroll(dy);
    t.result.scrolls++;
  };

  if (strategy.browseMode === 'quick') {
    if (!first) {
      for (let i = 0; i < QUICK.blindScrolls; i++) {
        await pause(QUICK.dwellSec);
        await scroll(px(QUICK.stepPx));
        if (t.estimate()) break;
      }
      return t.result;
    }
    const goal = randomInt(deps.random, QUICK.floors[0], QUICK.floors[1]);
    while (t.result.scrolls < QUICK.maxScrolls) {
      await pause(QUICK.dwellSec);
      await scroll(px(QUICK.stepPx));
      await sleep(QUICK.settleMs);
      const r = await surface.readCounter();
      if (r && t.advance(r)) break;
      if ((t.last ?? 0) - first.current >= goal) break;
      if (r && r.current >= r.total) break;
    }
    return t.result;
  }

  if (!first || first.total < DEEP.shortTopicFloors) {
    // F07 for short topics, F08 when no counter renders: a timed gentle scroll.
    const until = deps.clock.monotonic() + randomBetween(deps.random, TRADITIONAL.durationSec[0], TRADITIONAL.durationSec[1]) * 1000;
    while (deps.clock.monotonic() < until && t.result.scrolls < DEEP.maxScrolls) {
      await scroll(px(TRADITIONAL.stepPx));
      await pause(TRADITIONAL.intervalSec);
      const r = first ? await surface.readCounter() : null;
      if (first ? r !== null && t.advance(r) : t.estimate()) break;
    }
    return t.result;
  }

  let stuck = 0;
  while (t.result.scrolls < DEEP.maxScrolls) {
    // F03: read first, then scroll, then let the counter catch up.
    await pause(DEEP.dwellSec);
    await scroll(px(DEEP.stepPx));
    await sleep(DEEP.settleMs);
    let r = await surface.readCounter();
    const before = t.last;
    if (r && t.advance(r)) break;
    if (r && r.current >= r.total) break;
    stuck = t.last === before ? stuck + 1 : 0;
    if (stuck >= DEEP.stuckLimit && t.result.scrolls < DEEP.maxScrolls) {
      // F04
      await scroll(DEEP.bigStepPx);
      await sleep(DEEP.bigSettleMs);
      stuck = 0;
      r = await surface.readCounter();
      if (r && t.advance(r)) break;
      if (r && r.current >= r.total) break;
    }
  }
  return t.result;
}
