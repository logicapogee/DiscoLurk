import { randomInt, shuffle, type RandomSource } from './runtime';
import type { TopicCandidate } from './terms';

const MIN_UNREAD_BEFORE_TOPUP = 3;
const MAX_READ_TOPUP = 3;

/**
 * Pinned rows never qualify; unread topics come first, a short unread list is topped
 * up with at most three read topics, and read topics are used only when nothing is unread.
 */
export function selectCandidates(rows: readonly TopicCandidate[], random: RandomSource): TopicCandidate[] {
  const eligible = rows.filter((t) => !t.pinned);
  const unread = eligible.filter((t) => t.unread);
  const read = eligible.filter((t) => !t.unread);
  if (unread.length === 0) return read;
  if (unread.length >= MIN_UNREAD_BEFORE_TOPUP) return unread;
  return [...unread, ...shuffle(read, random).slice(0, MAX_READ_TOPUP)];
}

/** Draws `min`–`max` candidates per category, or all of them when there are fewer. */
export function sampleTopics<T>(
  candidates: readonly T[],
  random: RandomSource,
  range: { min: number; max: number } = { min: 3, max: 8 },
): T[] {
  const count = randomInt(random, range.min, range.max);
  return shuffle(candidates, random).slice(0, count);
}
