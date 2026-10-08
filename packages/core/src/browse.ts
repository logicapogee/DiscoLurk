import { emptyStats, toFailure, type RunEvent, type RunFailure, type RunStats } from './events';
import { sampleTopics, selectCandidates } from './picking';
import type { ActionPolicy, ForumPort } from './ports';
import { isAbortError, pauseBetween, shuffle, throwIfAborted, type RuntimeDeps } from './runtime';
import { targetReached } from './target';
import type { RunPlanSnapshot } from './terms';

export type BrowseEnd = 'target-reached' | 'cancelled' | 'no-progress' | 'error';

export interface BrowseInput {
  plan: RunPlanSnapshot;
  forum: ForumPort;
  deps: RuntimeDeps;
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
}

export type BrowseOutcome = { stats: RunStats } & ({ end: 'error'; failure: RunFailure } | { end: Exclude<BrowseEnd, 'error'> });

const BETWEEN_TOPICS = { minSec: 0.5, maxSec: 1.5 };

/**
 * The `browsing` state of §6.2 / §7.1: rounds over the enabled categories until the target is
 * reached (S02), the user stops (S05), or a whole round enters no topic (S06). Endless mode
 * only ends on stop (S01). Category order is reshuffled every round.
 */
export async function browse(input: BrowseInput): Promise<BrowseOutcome> {
  const { plan, forum, deps, signal, emit } = input;
  const { preset } = plan;
  const stats = emptyStats();
  const startedAt = deps.clock.monotonic();
  const at = () => new Date(deps.clock.now()).toISOString();
  const tick = () => {
    stats.elapsedMs = deps.clock.monotonic() - startedAt;
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
  const policy: ActionPolicy = structuredClone(preset.interaction);
  const { extraWait } = preset;

  try {
    for (;;) {
      let enteredThisRound = 0;
      for (const category of shuffle(preset.categories, deps.random)) {
        throwIfAborted(signal);
        const batch = await forum.collectTopics(category, { browseMode: preset.browseMode }, signal);
        if (batch.empty) emit({ type: 'warning', at: at(), code: 'empty-category', message: `${category.path} rendered no topic rows` });
        const picks = sampleTopics(selectCandidates(batch.topics, deps.random), deps.random, preset.samplePerCategory);

        for (const topic of picks) {
          throwIfAborted(signal);
          stats.attempted.topics++;
          emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'click' });
          const visit = await forum.enterFromList(topic, signal);
          if (!visit.entered) {
            emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'click', result: visit.reason });
            publish();
            continue;
          }
          enteredThisRound++;
          stats.confirmed.topics++;
          emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'entered' });
          publish();

          let done = reached();
          if (!done) {
            await forum.readTopic(
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
              signal,
            );
            emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'read' });
          }

          if (!done && (policy.like.enabled || policy.reply.enabled)) {
            throwIfAborted(signal);
            const r = await forum.performActions(policy, signal);
            stats.attempted.likes += r.likes.attempted;
            stats.confirmed.likes += r.likes.confirmed;
            stats.attempted.replyLikes += r.replyLikes.attempted;
            stats.confirmed.replyLikes += r.replyLikes.confirmed;
            stats.attempted.replies += r.replies.attempted;
            stats.confirmed.replies += r.replies.confirmed;
            if (r.replies.confirmed > 0) stats.confirmed.repliedTopics += 1;
            if (r.likeLimitHit && policy.like.enabled) {
              policy.like.enabled = false;
              emit({ type: 'warning', at: at(), code: 'like-limit', message: 'Likes disabled for this session' });
            }
            publish();
          }

          // Returning also gives the site its final /topics/timings flush (T10), so it runs even when the target is met.
          const verification = await forum.returnAndVerify(visit, signal);
          emit({ type: 'topic', at: at(), topicId: topic.id, phase: 'returned', result: verification });

          if (done || reached()) return { end: 'target-reached', stats: snapshot(stats, tick) };
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
  }
}

function snapshot(stats: RunStats, tick: () => void): RunStats {
  tick();
  return structuredClone(stats);
}
