import type { WaitRange } from './terms';

/** Every source of time and randomness is injected so tests can fix them. */
export interface Clock {
  /** Wall-clock epoch milliseconds; used for timestamps and schedules. */
  now(): number;
  /** Monotonic milliseconds; used for durations so wall-clock jumps cannot shorten a run. */
  monotonic(): number;
}

export interface RandomSource {
  /** Uniform in [0, 1). */
  next(): number;
}

export interface InterruptibleSleeper {
  /** Rejects with an `AbortError` as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface RuntimeDeps {
  clock: Clock;
  random: RandomSource;
  sleeper: InterruptibleSleeper;
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/** Settles with `promise`, or rejects as soon as `signal` aborts; `onAbort` releases whatever `promise` holds. */
export function untilAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export const systemSleeper: InterruptibleSleeper = {
  sleep(ms, signal) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return untilAbort(elapsed, signal, () => clearTimeout(timer));
  },
};

/** mulberry32: small, fast and good enough for pacing; a snapshot's `seed` replays the same choices. */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const systemRandom: RandomSource = { next: () => Math.random() };

export function systemDeps(): RuntimeDeps {
  return { clock: systemClock, random: systemRandom, sleeper: systemSleeper };
}

/** Inclusive integer range. */
export function randomInt(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random.next() * (max - min + 1));
}

export function randomBetween(random: RandomSource, min: number, max: number): number {
  return min + random.next() * (max - min);
}

/** A human-paced wait of a random length within `range`. */
export function pauseWithin(deps: Pick<RuntimeDeps, 'random' | 'sleeper'>, range: WaitRange, signal: AbortSignal): Promise<void> {
  return deps.sleeper.sleep(randomBetween(deps.random, range.minSec, range.maxSec) * 1000, signal);
}

export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
