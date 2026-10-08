import { emptyStats, toFailure, type RunEvent, type RunFailure, type RunStats } from './events';
import { rankTopics, type VisitLedger } from './ledger';
import { sampleTopics, selectCandidates } from './picking';
import type { ActionPolicy, ForumPort, ReadResult, TopicStrategy } from './ports';
import { isAbortError, pauseBetween, shuffle, throwIfAborted, type RuntimeDeps } from './runtime';
import { targetReached } from './target';
import type { TimingsTally } from './timings';
import { EXPERIMENTS_OFF, type Category, type RunPlanSnapshot, type TopicCandidate } from './terms';

export type BrowseEnd = 'target-reached' | 'cancelled' | 'no-progress' | 'error';

export interface BrowseInput {
  plan: RunPlanSnapshot;
  forum: ForumPort;
  deps: RuntimeDeps;
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
  /** The categories to browse; the plan's own when absent. */
  categories?: readonly Category[];
  /** The site's read receipts so far; every stats event carries their sum. */
  timings?: TimingsTally;
  /** Every visit is recorded here; the `smartRanked` experiment also reads it. */
  ledger?: VisitLedger;
}

export type BrowseOutcome = { stats: RunStats } & ({ end: 'error'; failure: RunFailure } | { end: Exclude<BrowseEnd, 'error'> });

/** Always taken, whatever the extra-wait switch says. */
const AFTER_READING = { minSec: 1, maxSec: 2 };
/** Taken only with the extra-wait switch on. */
const BETWEEN_TOPICS = { minSec: 0.5, maxSec: 1.5 };

/** What a step inside a topic yields when a time target ran out during it. */
const DEADLINE = Symbol('deadline');

/**
 * The `browsing` state: rounds over the enabled categories until the target is reached, the user
 * stops, or a whole round enters no topic. Endless mode only ends on stop. Category order is
 * reshuffled every round.
 */
export async function browse(input: BrowseInput): Promise<BrowseOutcome> {
  const { plan, forum, deps, signal, emit } = input;
  const { preset } = plan;
  const experiments = preset.experiments ?? EXPERIMENTS_OFF;
  const categories = input.categories ?? preset.categories;
  const stats = emptyStats();
  const startedAt = deps.clock.monotonic();
  const at = () => new Date(deps.clock.now()).toISOString();
  const warn = (code: string, message: string) => emit({ type: 'warning', at: at(), code, message });
  const tick = () => {
    stats.elapsedMs = deps.clock.monotonic() - startedAt;
    if (input.timings) stats.timings = input.timings.snapshot();
  };
  const publish = () => {
    tick();
    emit({ type: 'stats', at: at(), stats: structuredClone(stats) });
  };
  const reached = () => {
    tick();
    return targetReached(preset.runMode, preset.browseMode, stats);
  };
  const pause = (range: { minSec: number; maxSec: number }) => pauseBetween(deps, range.minSec, range.maxSec, signal);
  const { extraWait } = preset;
  const policy: ActionPolicy = {
    ...structuredClone(preset.interaction),
    extraWait,
    onAction: (report) => emit({ type: 'action', at: at(), action: report.action, result: report.result }),
  };
  const strategy: TopicStrategy = {
    browseMode: preset.browseMode,
    lists: [...(experiments.useNewList ? (['new'] as const) : []), ...(experiments.useUnreadList ? (['unread'] as const) : [])],
  };

  // A time target cuts reading and interaction short the moment it runs out, so the run ends on
  // time rather than at the next floor; the return to the list still happens.
  const deadline = new AbortController();
  const disarm = new AbortController();
  if (preset.runMode.kind === 'time') {
    deps.sleeper.sleep(preset.runMode.minutes * 60_000, AbortSignal.any([signal, disarm.signal])).then(
      () => deadline.abort(),
      () => {},
    );
  }
  const inTopic = AbortSignal.any([signal, deadline.signal]);
  const untilTarget = async <T>(step: (s: AbortSignal) => Promise<T>): Promise<T | typeof DEADLINE> => {
    try {
      return await step(inTopic);
    } catch (err) {
      if (deadline.signal.aborted && !signal.aborted && isAbortError(err)) return DEADLINE;
      throw err;
    }
  };

  const pick = (topics: TopicCandidate[], unreadPosts: boolean) => {
    const candidates = selectCandidates(topics, deps.random, { unreadPosts });
    if (experiments.smartRanked && input.ledger) return rankTopics(candidates, input.ledger, deps.clock.now(), deps.random, preset.samplePerCategory);
    return sampleTopics(candidates, deps.random, preset.samplePerCategory);
  };

  /** One topic from click to return; true once the target is met. */
  const visitTopic = async (topic: TopicCandidate): Promise<boolean> => {
    stats.attempted.topics++;
    emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'click' });
    const visit = await forum.enterFromList(topic, signal);
    if (!visit.entered) {
      emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'click', result: visit.reason });
      input.ledger?.record({ topicId: topic.id, lastVisitAt: at(), entered: false, failure: visit.reason });
      publish();
      return false;
    }
    stats.confirmed.topics++;
    emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'entered' });
    publish();

    let done = reached();
    let read: ReadResult | null = null;
    if (!done) {
      const r = await untilTarget((s) =>
        forum.readTopic(
          visit,
          {
            browseMode: preset.browseMode,
            onFloor: (advance) => {
              const delta = Math.max(0, advance.to - advance.from);
              stats.attempted.floors += delta;
              if (advance.confirmed) stats.confirmed.floors += delta;
              else stats.estimatedFloors += delta;
              emit({ type: 'floor', at: at(), ...advance });
              publish();
              done = reached();
              return done ? 'stop' : 'continue';
            },
          },
          s,
        ),
      );
      if (r === DEADLINE) done = true;
      else read = r;
      emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'read' });
      await pause(AFTER_READING);
      done ||= reached();
    }

    if (!done && (policy.like.enabled || policy.reply.enabled)) {
      throwIfAborted(signal);
      const r = await untilTarget((s) => forum.performActions(policy, s));
      if (r === DEADLINE) done = true;
      else {
        stats.attempted.likes += r.likes.attempted;
        stats.confirmed.likes += r.likes.confirmed;
        stats.attempted.replyLikes += r.replyLikes.attempted;
        stats.confirmed.replyLikes += r.replyLikes.confirmed;
        stats.attempted.replies += r.replies.attempted;
        stats.confirmed.replies += r.replies.confirmed;
        if (r.replies.confirmed > 0) stats.confirmed.repliedTopics += 1;
        if (r.likeLimitHit && policy.like.enabled) {
          policy.like.enabled = false;
          warn('like-limit', 'Two likes in a row went unconfirmed; likes are off for the rest of this run');
        }
        publish();
      }
    }

    // Returning also gives the site its final /topics/timings flush, so it runs even when the target is met.
    const verification = await forum.returnAndVerify(visit, signal);
    stats.returns[verification]++;
    emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'returned', result: verification });
    if (verification === 'still-unread') warn('still-unread', `Topic ${topic.id} still shows the new-topic badge; the site may not have counted the visit`);
    input.ledger?.record({
      topicId: topic.id,
      lastVisitAt: at(),
      entered: true,
      verification,
      ...(read && read.startFloor !== null && read.endFloor !== null ? { floors: { from: read.startFloor, to: read.endFloor } } : {}),
    });
    publish();
    return done || reached();
  };

  try {
    for (;;) {
      let enteredThisRound = 0;
      for (const category of shuffle(categories, deps.random)) {
        throwIfAborted(signal);
        const batch = await forum.collectTopics(category, strategy, signal);
        if (batch.topics.length === 0) warn('empty-category', `${category.path} rendered no topic rows`);
        for (const topic of pick(batch.topics, batch.source === 'unread')) {
          throwIfAborted(signal);
          // A time target can run out during a pause; no topic is entered after that.
          if (reached()) return { end: 'target-reached', stats: snapshot(stats, tick) };
          const before = stats.confirmed.topics;
          const met = await visitTopic(topic);
          if (stats.confirmed.topics > before) enteredThisRound++;
          if (met) return { end: 'target-reached', stats: snapshot(stats, tick) };
          if (extraWait.enabled) await pause(BETWEEN_TOPICS);
        }

        if (reached()) return { end: 'target-reached', stats: snapshot(stats, tick) };
        if (extraWait.enabled) await pause({ minSec: extraWait.minSec + 1, maxSec: extraWait.maxSec + 2 });
      }
      if (enteredThisRound === 0) return { end: 'no-progress', stats: snapshot(stats, tick) };
    }
  } catch (err) {
    if (isAbortError(err)) return { end: 'cancelled', stats: snapshot(stats, tick) };
    return { end: 'error', stats: snapshot(stats, tick), failure: toFailure(err) };
  } finally {
    disarm.abort();
  }
}

function snapshot(stats: RunStats, tick: () => void): RunStats {
  tick();
  return structuredClone(stats);
}
