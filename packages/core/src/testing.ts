import type { LevelSnapshot } from './metrics';
import type {
  ActionPolicy,
  ActionResult,
  AuthMode,
  AuthResult,
  ForumPort,
  ReadResult,
  ReadStrategy,
  ReadVerification,
  TopicBatch,
  TopicStrategy,
  TopicVisit,
} from './ports';
import { abortError, seededRandom, type Clock, type InterruptibleSleeper, type RuntimeDeps } from './runtime';
import type { Category, Site, TopicCandidate } from './terms';

/** A minimal valid Site: discovered categories, no progress page. */
export function fixtureSite(over: Partial<Site> = {}): Site {
  return {
    id: 'fixture',
    displayName: 'Fixture',
    baseUrl: 'https://forum.invalid',
    kind: 'discourse',
    login: 'headed',
    categorySource: 'discovered',
    progressSource: 'none',
    behaviorVerified: { clickEntryRequired: 'unverified' },
    ...over,
  };
}

interface Timer {
  at: number;
  seq: number;
  fire: () => void;
}

const flushIo = () => new Promise<void>((r) => setImmediate(r));

/**
 * Deterministic time for tests (§13.2). Sleeps only complete when `drive` advances the clock,
 * so a test can assert exactly how much virtual time passed between an abort and the result.
 */
export class VirtualTime {
  private wall: number;
  private mono = 0;
  private timers: Timer[] = [];
  private seq = 0;

  constructor(startEpochMs = Date.UTC(2026, 9, 8, 0, 0, 0)) {
    this.wall = startEpochMs;
  }

  readonly clock: Clock = {
    now: () => this.wall,
    monotonic: () => this.mono,
  };

  readonly sleeper: InterruptibleSleeper = {
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal));
        const timer: Timer = {
          at: this.mono + Math.max(0, ms),
          seq: this.seq++,
          fire: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          this.timers = this.timers.filter((t) => t !== timer);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.timers.push(timer);
      }),
  };

  deps(seed = 1): RuntimeDeps {
    return { clock: this.clock, random: seededRandom(seed), sleeper: this.sleeper };
  }

  /** Runs `fn` once the monotonic clock reaches `atMs`. */
  at(atMs: number, fn: () => void): void {
    this.timers.push({ at: atMs, seq: this.seq++, fire: fn });
  }

  /** Moves the wall clock without moving the monotonic clock, as an NTP correction would. */
  jumpWallClock(deltaMs: number): void {
    this.wall += deltaMs;
  }

  /** Advances virtual time timer by timer until `promise` settles. */
  async drive<T>(promise: Promise<T>, maxTimers = 1_000_000): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    promise.then(
      (v) => {
        settled = true;
        value = v;
      },
      (e: unknown) => {
        settled = true;
        failed = true;
        error = e;
      },
    );
    for (let i = 0; i < maxTimers; i++) {
      await flushIo();
      if (settled) break;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (!next) throw new Error('VirtualTime.drive: promise is pending with no timers left');
      if (next.at > this.mono) {
        this.wall += next.at - this.mono;
        this.mono = next.at;
      }
      next.fire();
    }
    if (!settled) throw new Error('VirtualTime.drive: timer budget exhausted');
    if (failed) throw error;
    return value as T;
  }
}

export interface FixtureForumOptions {
  site: Site;
  sleeper: InterruptibleSleeper;
  /** Rows the list page shows for a category path; defaults to none. */
  topics: (categoryPath: string, call: number) => TopicCandidate[];
  /** Whether clicking a topic lands on it; defaults to always. */
  enters?: (topic: TopicCandidate) => boolean;
  /** Floor counter readings while reading a topic, one per dwell; defaults to 1→5. */
  floors?: (topic: TopicCandidate) => number[];
  floorsConfirmed?: boolean;
  /** Simulated page latencies in milliseconds. */
  latency?: { collect?: number; enter?: number; dwell?: number; back?: number };
  /** Answers `ensureAuthenticated`; defaults to authenticated at once. */
  auth?: (mode: AuthMode, signal: AbortSignal) => Promise<AuthResult>;
  /** Answers `readProgress`; defaults to null, as for `progressSource: 'none'`. */
  progress?: (kind: 'initial' | 'final', signal: AbortSignal) => Promise<LevelSnapshot | null>;
  /** What `discoverCategories` finds; defaults to none. */
  discovered?: Category[];
  /** Answers `returnAndVerify` (T11); defaults to the badge gone for unread topics and not-applicable for the rest. */
  verify?: (topic: TopicCandidate) => ReadVerification;
}

export type FixtureCall =
  | { op: 'ensureAuthenticated'; mode: AuthMode }
  | { op: 'discoverCategories' }
  | { op: 'readProgress'; kind: 'initial' | 'final' }
  | { op: 'collectTopics'; category: string }
  | { op: 'enterFromList'; topicId: string }
  | { op: 'readTopic'; topicId: string }
  | { op: 'performActions' }
  | { op: 'returnAndVerify'; topicId: string };

/** A `ForumPort` over in-memory rows (§13.1, D11): proves kernel ordering and counting, nothing about the real site. */
export class FixtureForum implements ForumPort {
  readonly site: Site;
  readonly calls: FixtureCall[] = [];
  private collectCount = new Map<string, number>();

  constructor(private readonly opts: FixtureForumOptions) {
    this.site = opts.site;
  }

  private wait(ms: number | undefined, signal: AbortSignal) {
    return this.opts.sleeper.sleep(ms ?? 0, signal);
  }

  async ensureAuthenticated(mode: AuthMode, signal: AbortSignal): Promise<AuthResult> {
    this.calls.push({ op: 'ensureAuthenticated', mode });
    return this.opts.auth ? this.opts.auth(mode, signal) : { status: 'authenticated' };
  }

  async discoverCategories(): Promise<Category[]> {
    this.calls.push({ op: 'discoverCategories' });
    return structuredClone(this.opts.discovered ?? []);
  }

  async readProgress(kind: 'initial' | 'final', signal: AbortSignal): Promise<LevelSnapshot | null> {
    this.calls.push({ op: 'readProgress', kind });
    return this.opts.progress ? this.opts.progress(kind, signal) : null;
  }

  async collectTopics(category: Category, _strategy: TopicStrategy, signal: AbortSignal): Promise<TopicBatch> {
    this.calls.push({ op: 'collectTopics', category: category.path });
    const n = this.collectCount.get(category.path) ?? 0;
    this.collectCount.set(category.path, n + 1);
    await this.wait(this.opts.latency?.collect ?? 1000, signal);
    return { category, topics: this.opts.topics(category.path, n) };
  }

  async enterFromList(topic: TopicCandidate, signal: AbortSignal): Promise<TopicVisit> {
    this.calls.push({ op: 'enterFromList', topicId: topic.id });
    await this.wait(this.opts.latency?.enter ?? 1000, signal);
    return (this.opts.enters?.(topic) ?? true)
      ? { topic, entered: true }
      : { topic, entered: false, reason: 'click-not-confirmed' };
  }

  async readTopic(visit: TopicVisit, strategy: ReadStrategy, signal: AbortSignal): Promise<ReadResult> {
    this.calls.push({ op: 'readTopic', topicId: visit.topic.id });
    const readings = this.opts.floors?.(visit.topic) ?? [1, 2, 3, 4, 5];
    let last = readings[0] ?? null;
    let scrolls = 0;
    for (const floor of readings.slice(1)) {
      await this.wait(this.opts.latency?.dwell ?? 3000, signal);
      scrolls++;
      if (last !== null && floor !== last) {
        const verdict = strategy.onFloor({ from: last, to: floor, confirmed: this.opts.floorsConfirmed ?? true });
        last = floor;
        if (verdict === 'stop') return { startFloor: readings[0] ?? null, endFloor: last, scrolls, stoppedByTarget: true, layout: 'wide' };
      }
    }
    return { startFloor: readings[0] ?? null, endFloor: last, scrolls, stoppedByTarget: false, layout: 'wide' };
  }

  async performActions(_policy: ActionPolicy, _signal: AbortSignal): Promise<ActionResult> {
    this.calls.push({ op: 'performActions' });
    const none = { attempted: 0, confirmed: 0 };
    return { likes: none, replyLikes: none, replies: none, likeLimitHit: false };
  }

  async returnAndVerify(visit: TopicVisit, signal: AbortSignal): Promise<ReadVerification> {
    this.calls.push({ op: 'returnAndVerify', topicId: visit.topic.id });
    await this.wait(this.opts.latency?.back ?? 2500, signal);
    return this.opts.verify?.(visit.topic) ?? (visit.topic.unread ? 'confirmed' : 'not-applicable');
  }
}
