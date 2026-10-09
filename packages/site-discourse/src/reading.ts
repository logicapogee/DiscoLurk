import { pauseWithin, randomBetween, randomInt, type ReadResult, type ReadStrategy, type RuntimeDeps, type WaitRange } from '@disco-lurk/core';
import type { FloorReading } from './parse';

/** The two things reading needs from a topic page; tests drive the strategies through a scripted one. */
export interface FloorSurface {
  /** Resolves once the page is visible; the site counts no reading time while it is hidden. */
  whenVisible(signal: AbortSignal): Promise<void>;
  readCounter(): Promise<FloorReading | null>;
  /** Rendered posts on the page; 0 when none can be counted. */
  countPosts(): Promise<number>;
  scroll(dy: number, signal: AbortSignal): Promise<void>;
}

/** Every value is a field-tested default, not a tuning knob. */
/**
 * Entering a topic waits in two stages: wait for the floor counter for at most `counterCeilingMs`, polling every
 * `pollMs`; then, whether it appeared or not, pause `extraSec` before reading.
 */
const ENTRY_WAIT = { counterCeilingMs: 5_000, pollMs: 500, extraSec: { minSec: 1, maxSec: 3 } } as const;
export const DEEP = {
  dwellSec: { minSec: 2, maxSec: 4 },
  stepPx: [600, 1200],
  settleMs: 500,
  stuckLimit: 3,
  bigStepPx: 1500,
  bigSettleMs: 1_000,
  maxScrolls: 200,
  shortTopicFloors: 10,
} as const;
const TRADITIONAL = { durationSec: [8, 15], stepPx: [150, 400], intervalSec: { minSec: 1, maxSec: 3 } } as const;
export const QUICK = { floors: [3, 5], dwellSec: { minSec: 1, maxSec: 2 }, stepPx: [400, 800], settleMs: 300, maxScrolls: 10, blindScrolls: 3 } as const;

interface Tracker {
  result: ReadResult;
  last: number | null;
  /** Reports an advance; true when the strategy asked to stop. */
  advance(reading: FloorReading): boolean;
  /** Reports floors seen without a counter, never as confirmed. */
  estimate(floors: number): boolean;
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
      // Only the climb between consecutive readings counts; a reading below the high-water mark adds nothing.
      if (reading.current <= t.last) return false;
      const verdict = strategy.onFloor({ from: t.last, to: reading.current, confirmed: true });
      t.last = reading.current;
      t.result.endFloor = reading.current;
      if (verdict === 'stop') t.result.stoppedByTarget = true;
      return verdict === 'stop';
    },
    estimate(floors) {
      const from = t.result.endFloor ?? 0;
      t.result.endFloor = from + floors;
      const verdict = strategy.onFloor({ from, to: from + floors, confirmed: false });
      if (verdict === 'stop') t.result.stoppedByTarget = true;
      return verdict === 'stop';
    },
  };
  return t;
}

/**
 * Reads a topic in deep or quick mode. Every wait goes through the injected sleeper, so a stop
 * lands within one sleep and tests run on virtual time.
 */
export async function readFloors(surface: FloorSurface, strategy: ReadStrategy, deps: RuntimeDeps, signal: AbortSignal): Promise<ReadResult> {
  const sleep = (ms: number) => deps.sleeper.sleep(ms, signal);
  const pause = (range: WaitRange) => pauseWithin(deps, range, signal);
  // Every dwell is reading time the site only counts on a visible page.
  const dwell = async (range: WaitRange) => {
    await surface.whenVisible(signal);
    await pause(range);
  };
  const px = (range: readonly [number, number]) => Math.round(randomBetween(deps.random, range[0], range[1]));

  // A counter that has not rendered yet reads as null, which would wrongly fall back to blind scrolling.
  let first: FloorReading | null = null;
  for (let waited = 0; ; waited += ENTRY_WAIT.pollMs) {
    first = await surface.readCounter();
    if (first || waited >= ENTRY_WAIT.counterCeilingMs) break;
    await sleep(ENTRY_WAIT.pollMs);
  }
  await pause(ENTRY_WAIT.extraSec);
  first = (await surface.readCounter()) ?? first;

  const t = tracker(first, strategy);
  const scroll = async (dy: number) => {
    await surface.scroll(dy, signal);
    t.result.scrolls++;
  };

  // Without a counter the topic is credited with the posts it rendered, at least the one floor every
  // topic has (a one-floor topic shows no counter at all); scrolling while reading adds nothing to it.
  const estimateFromPosts = async () => t.estimate(Math.max(1, await surface.countPosts()));

  if (strategy.browseMode === 'quick') {
    if (!first) {
      for (let i = 0; i < QUICK.blindScrolls; i++) {
        await dwell(QUICK.dwellSec);
        await scroll(px(QUICK.stepPx));
      }
      await estimateFromPosts();
      return t.result;
    }
    const goal = randomInt(deps.random, QUICK.floors[0], QUICK.floors[1]);
    while (t.result.scrolls < QUICK.maxScrolls) {
      await dwell(QUICK.dwellSec);
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
    // Short topics, and topics that render no counter, get a timed gentle scroll.
    const until = deps.clock.monotonic() + randomBetween(deps.random, TRADITIONAL.durationSec[0], TRADITIONAL.durationSec[1]) * 1000;
    while (deps.clock.monotonic() < until && t.result.scrolls < DEEP.maxScrolls) {
      await scroll(px(TRADITIONAL.stepPx));
      await dwell(TRADITIONAL.intervalSec);
      const r = first ? await surface.readCounter() : null;
      if (r !== null && t.advance(r)) break;
    }
    if (!first) await estimateFromPosts();
    return t.result;
  }

  let stuck = 0;
  // Set once the big step has been taken for the current stall; a stall that outlasts it ends the topic.
  let escalated = false;
  while (t.result.scrolls < DEEP.maxScrolls) {
    // Read first, then scroll, then let the counter catch up.
    await dwell(DEEP.dwellSec);
    await scroll(px(DEEP.stepPx));
    await sleep(DEEP.settleMs);
    let before = t.last;
    let r = await surface.readCounter();
    if (r && t.advance(r)) break;
    if (r && r.current >= r.total) break;
    if (t.last !== before) {
      stuck = 0;
      escalated = false;
      continue;
    }
    if (++stuck < DEEP.stuckLimit) continue;
    if (escalated) break;
    if (t.result.scrolls >= DEEP.maxScrolls) break;
    // A stalled counter gets one big step before the stall can end the topic.
    await scroll(DEEP.bigStepPx);
    await sleep(DEEP.bigSettleMs);
    stuck = 0;
    before = t.last;
    r = await surface.readCounter();
    if (r && t.advance(r)) break;
    if (r && r.current >= r.total) break;
    escalated = t.last === before;
  }
  return t.result;
}
