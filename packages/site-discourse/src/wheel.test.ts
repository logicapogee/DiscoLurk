import { describe, expect, it } from 'vitest';
import { seededRandom } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { WHEEL, wheelInNotches } from './wheel';

function wheelLog(time: VirtualTime) {
  const events: Array<{ dy: number; at: number }> = [];
  return { events, page: { wheel: async (_dx: number, dy: number) => void events.push({ dy, at: time.clock.monotonic() }) } };
}

describe('wheelInNotches', () => {
  it('splits a step into notch-sized wheel events that add up to it, with a gap between each', async () => {
    const time = new VirtualTime();
    const { events, page } = wheelLog(time);
    await time.drive(wheelInNotches(page, 1000, { ...time.deps(), random: seededRandom(7) }, new AbortController().signal));
    expect(events.reduce((sum, e) => sum + e.dy, 0)).toBe(1000);
    expect(events.length).toBeGreaterThanOrEqual(Math.ceil(1000 / WHEEL.tickPx[1]));
    for (const e of events) expect(e.dy).toBeLessThanOrEqual(WHEEL.tickPx[1]);
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.at - events[i - 1]!.at;
      expect(gap).toBeGreaterThanOrEqual(WHEEL.gapMs[0]);
      expect(gap).toBeLessThanOrEqual(WHEEL.gapMs[1]);
    }
  });

  it('scrolls up with negative notches', async () => {
    const time = new VirtualTime();
    const { events, page } = wheelLog(time);
    await time.drive(wheelInNotches(page, -250, { ...time.deps(), random: seededRandom(3) }, new AbortController().signal));
    expect(events.every((e) => e.dy < 0)).toBe(true);
    expect(events.reduce((sum, e) => sum + e.dy, 0)).toBe(-250);
  });

  it('stops between notches once the signal aborts', async () => {
    const time = new VirtualTime();
    const { events, page } = wheelLog(time);
    const ctl = new AbortController();
    page.wheel = async (_dx, dy) => {
      events.push({ dy, at: time.clock.monotonic() });
      ctl.abort();
    };
    await expect(time.drive(wheelInNotches(page, 1000, time.deps(), ctl.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toHaveLength(1);
  });
});
