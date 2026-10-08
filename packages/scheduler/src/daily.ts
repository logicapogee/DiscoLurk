import { randomBetween, type RandomSource } from '@disco-lurk/core';

export interface DailyWindow {
  runs: number;
  /** Minutes since local midnight. */
  start: number;
  end: number;
  jitterMinutes: number;
  minGapMinutes: number;
}

const ATTEMPTS = 500;

const gapsOk = (points: number[], gap: number) => points.every((p, i) => i === 0 || p - points[i - 1]! >= gap);

/**
 * Random daily schedule: up to `runs` minute-of-day points inside [from, end], pairwise at
 * least `minGapMinutes` apart, each nudged by ±`jitterMinutes` when that keeps the gaps. `from`
 * lets a day generated mid-window use only the part still ahead, so no run starts out missed.
 */
export function dailyPoints(w: DailyWindow, from: number, random: RandomSource): number[] {
  const lo = Math.max(w.start, from);
  if (w.end <= w.start) throw new Error('daily-window end must be after start');
  if (lo > w.end) return [];
  const fit = Math.min(w.runs, Math.floor((w.end - lo) / Math.max(w.minGapMinutes, 1)) + 1);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const points = Array.from({ length: fit }, () => Math.round(randomBetween(random, lo, w.end))).sort((a, b) => a - b);
    if (!gapsOk(points, w.minGapMinutes)) continue;
    for (let i = 0; i < points.length; i++) {
      const original = points[i]!;
      const jitter = randomBetween(random, -w.jitterMinutes, w.jitterMinutes);
      points[i] = Math.min(w.end, Math.max(lo, Math.round(original + jitter)));
      if (!gapsOk(points, w.minGapMinutes)) points[i] = original;
    }
    return points;
  }
  // Rejection sampling only fails when the window is nearly full; evenly spaced points always fit.
  const step = fit > 1 ? (w.end - lo) / (fit - 1) : 0;
  return Array.from({ length: fit }, (_, i) => Math.round(lo + i * step));
}
