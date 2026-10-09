import { randomInt, untilAbort, type RuntimeDeps } from '@disco-lurk/core';
import type { ReadOnlyPage } from './page';

/** One wheel notch and the gap between notches, as a person's wheel sends them; field-tested defaults. */
export const WHEEL = { tickPx: [80, 120], gapMs: [30, 80], centerRounds: 4 } as const;

/**
 * Scrolls `dy` as a run of notch-sized wheel events. A single large wheel event lands in one frame,
 * which reads as a jump on screen; notches with gaps let the page scroll the way a hand would.
 */
export async function wheelInNotches(page: Pick<ReadOnlyPage, 'wheel'>, dy: number, deps: Pick<RuntimeDeps, 'random' | 'sleeper'>, signal: AbortSignal): Promise<void> {
  const direction = Math.sign(dy);
  let left = Math.abs(Math.round(dy));
  while (left > 0) {
    const notch = Math.min(left, randomInt(deps.random, WHEEL.tickPx[0], WHEEL.tickPx[1]));
    await page.wheel(0, direction * notch);
    left -= notch;
    if (left > 0) await deps.sleeper.sleep(randomInt(deps.random, WHEEL.gapMs[0], WHEEL.gapMs[1]), signal);
  }
}

/**
 * Wheels the first match of `selector` toward the viewport's centre until it sits within `withinPx`
 * of it, over the middle of the page. Content above may grow while the wheel turns (images, cloaked
 * posts rendering), so the element is measured again after each pass. A missing element times out.
 */
export async function wheelToCenter(
  page: Pick<ReadOnlyPage, 'wheel' | 'moveMouse' | 'viewportSize' | 'offsetFromCenter'>,
  selector: string,
  withinPx: number,
  deps: Pick<RuntimeDeps, 'random' | 'sleeper'>,
  signal: AbortSignal,
): Promise<void> {
  const { width, height } = await page.viewportSize();
  await page.moveMouse(Math.round(width / 2), Math.round(height / 2));
  for (let round = 0; round < WHEEL.centerRounds; round++) {
    const offset = await untilAbort(page.offsetFromCenter(selector), signal);
    if (Math.abs(offset) <= withinPx) return;
    await wheelInNotches(page, offset, deps, signal);
  }
}
