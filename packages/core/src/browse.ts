import { addActionReport, emptyStats, toFailure, type RunEvent, type RunFailure, type RunStats } from './events';
import { rankTopics, type VisitLedger } from './ledger';
import { sampleTopics, selectCandidates } from './picking';
import type { ActionPolicy, ActionReport, ForumPort, ReadResult, TopicStrategy, TopicVisit } from './ports';
import { isAbortError, pauseWithin, shuffle, throwIfAborted, type RuntimeDeps } from './runtime';
import { targetReached } from './target';
import type { TimingsTally } from './timings';
import type { Category, ResolvedPreset, RunMode, RunPlanSnapshot, TopicCandidate, WaitRange } from './terms';

type BrowseEnd = 'target-reached' | 'cancelled' | 'no-progress' | 'error';

interface BrowseInput {
  plan: RunPlanSnapshot;
  forum: ForumPort;
  deps: RuntimeDeps;
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
  /** The categories to browse, which a run may have refreshed from the plan's. */
  categories: readonly Category[];
  /** The site's read receipts so far; every stats event carries their sum. */
  timings: TimingsTally;
  /** Every visit is recorded here; the `smartRanked` experiment also reads it. Absent when the Profile's ledger could not be opened. */
  ledger?: VisitLedger;
}

type BrowseOutcome = { stats: RunStats } & ({ end: 'error'; failure: RunFailure } | { end: Exclude<BrowseEnd, 'error'> });

/** Always taken, whatever the extra-wait switch says. */
const AFTER_READING = { minSec: 1, maxSec: 2 };
/** Taken only with the extra-wait switch on. */
const BETWEEN_TOPICS = { minSec: 0.5, maxSec: 1.5 };
/** Discourse's daily like limit shows up as likes that never turn into the liked state. */
const LIKE_LIMIT_AFTER = 2;

/**
 * A time target's deadline: it aborts once the run's minutes are up, and never for other run
 * modes. `disarm` releases the timer when browsing ends first.
 */
function armDeadline(runMode: RunMode, deps: Pick<RuntimeDeps, 'sleeper'>, signal: AbortSignal): { signal: AbortSignal; disarm(): void } {
  const deadline = new AbortController();
  const disarm = new AbortController();
  if (runMode.kind === 'time') {
    deps.sleeper.sleep(runMode.minutes * 60_000, AbortSignal.any([signal, disarm.signal])).then(
      () => deadline.abort(),
      (err: unknown) => {
        // Disarming or a stop ends the timer by aborting its sleep; anything else is a real fault.
        if (!isAbortError(err)) throw err;
      },
    );
  }
  return { signal: deadline.signal, disarm: () => disarm.abort() };
}

interface BrowseContext {
  preset: ResolvedPreset;
  forum: ForumPort;
  deps: RuntimeDeps;
  /** The run's stop requests. */
  signal: AbortSignal;
  /** Aborts once a time target runs out. */
  deadline: AbortSignal;
  /** Stop requests and the deadline: what cuts entering, reading and interacting short. */
  inTopic: AbortSignal;
  emit: (e: RunEvent) => void;
  stats: RunStats;
  startedAt: number;
  timings: TimingsTally;
  ledger: VisitLedger | undefined;
  policy: ActionPolicy;
  /** Starts as the preset's like switch; the like limit turns it off for the rest of the run. */
  liking: boolean;
  /** Starts as the preset's reply switch; `disableReplies` turns it off for the rest of the run. */
  replying: boolean;
  /** Unconfirmed likes in a row, across topics. */
  likeRejections: number;
  /** The topic being visited, which a confirmed reply is credited to. */
  topicId: string | null;
  /** Topics with a confirmed reply in this run, so a topic met again in a later round counts once. */
  repliedTopics: Set<string>;
}

const timestamp = (ctx: BrowseContext) => new Date(ctx.deps.clock.now()).toISOString();

const warn = (ctx: BrowseContext, code: string, message: string) => ctx.emit({ type: 'warning', at: timestamp(ctx), code, message });

/** Brings the measured parts of the stats up to now: elapsed time and the read receipts. */
function refreshStats(ctx: BrowseContext): void {
  ctx.stats.elapsedMs = ctx.deps.clock.monotonic() - ctx.startedAt;
  ctx.stats.timings = ctx.timings.snapshot();
}

function emitStats(ctx: BrowseContext): void {
  refreshStats(ctx);
  ctx.emit({ type: 'stats', at: timestamp(ctx), stats: structuredClone(ctx.stats) });
}

function finalStats(ctx: BrowseContext): RunStats {
  refreshStats(ctx);
  return structuredClone(ctx.stats);
}

/** A time target is met exactly when its deadline fires; the other modes count progress. */
function reached(ctx: BrowseContext): boolean {
  refreshStats(ctx);
  if (ctx.preset.runMode.kind === 'time') return ctx.deadline.aborted;
  return targetReached(ctx.preset.runMode, ctx.preset.browseMode, ctx.stats);
}

/** Thrown by `checkpoint` once the target is met; `browse` turns it into its `target-reached` ending. */
const TARGET_REACHED = Symbol('target-reached');

/**
 * Where browsing may end before its next step (collecting a list, entering a topic, pausing): a
 * stop request throws its abort error, a met target throws `TARGET_REACHED`.
 */
function checkpoint(ctx: BrowseContext): void {
  throwIfAborted(ctx.signal);
  if (reached(ctx)) throw TARGET_REACHED;
}

const pause = (ctx: BrowseContext, range: WaitRange) => pauseWithin(ctx.deps, range, ctx.signal);

/**
 * Runs a step under `inTopic`. A time target that runs out mid-step resolves it to null, so the
 * run ends on time rather than at the next floor; a stop request still throws.
 */
async function untilTarget<T>(ctx: BrowseContext, step: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  try {
    return await step(ctx.inTopic);
  } catch (err) {
    if (ctx.deadline.aborted && !ctx.signal.aborted && isAbortError(err)) return null;
    throw err;
  }
}

function onAction(ctx: BrowseContext, report: ActionReport): void {
  ctx.emit({ type: 'action', at: timestamp(ctx), action: report.action, result: report.result });
  addActionReport(ctx.stats, report);
  if (report.bucket === 'reply-post' && report.result === 'confirmed' && ctx.topicId !== null && !ctx.repliedTopics.has(ctx.topicId)) {
    ctx.repliedTopics.add(ctx.topicId);
    ctx.stats.confirmed.repliedTopics++;
  }
  if (report.action !== 'like' || report.result === 'attempted') return;
  ctx.likeRejections = report.result === 'rejected' ? ctx.likeRejections + 1 : 0;
  if (ctx.liking && ctx.likeRejections >= LIKE_LIMIT_AFTER) {
    ctx.liking = false;
    warn(ctx, 'like-limit', 'Two likes in a row went unconfirmed; likes are off for the rest of this run');
  }
}

/**
 * Clicks into the topic; null when it was not entered. A deadline that lands after the click but
 * before the entry was confirmed still yields the visit when the page is on the topic, so the
 * topic is left the usual way and recorded.
 */
async function enter(ctx: BrowseContext, topic: TopicCandidate): Promise<TopicVisit | null> {
  ctx.stats.attempted.topics++;
  ctx.emit({ type: 'topic', at: timestamp(ctx), topicId: topic.id, phase: 'click' });
  // A hidden window holds entering until it is visible again, so a time target must be able to end that wait.
  const visit = await untilTarget(ctx, (s) => ctx.forum.enterFromList(topic, s));
  if (!visit) return ctx.forum.showsTopic(topic) ? { topic, entered: true } : null;
  if (!visit.entered) {
    ctx.emit({ type: 'topic', at: timestamp(ctx), topicId: topic.id, phase: 'click', result: visit.reason });
    ctx.ledger?.record({ topicId: topic.id, lastVisitAt: timestamp(ctx), entered: false, failure: visit.reason });
    emitStats(ctx);
    return null;
  }
  ctx.stats.confirmed.topics++;
  ctx.emit({ type: 'topic', at: timestamp(ctx), topicId: topic.id, phase: 'entered' });
  emitStats(ctx);
  return visit;
}

async function read(ctx: BrowseContext, visit: TopicVisit): Promise<ReadResult | null> {
  const { stats } = ctx;
  const result = await untilTarget(ctx, (s) =>
    ctx.forum.readTopic(
      visit,
      {
        browseMode: ctx.preset.browseMode,
        onFloor: (advance) => {
          const delta = Math.max(0, advance.to - advance.from);
          stats.attempted.floors += delta;
          if (advance.confirmed) stats.confirmed.floors += delta;
          else stats.estimatedFloors += delta;
          ctx.emit({ type: 'floor', at: timestamp(ctx), ...advance });
          emitStats(ctx);
          return reached(ctx) ? 'stop' : 'continue';
        },
      },
      s,
    ),
  );
  ctx.emit({ type: 'topic', at: timestamp(ctx), topicId: visit.topic.id, phase: 'read' });
  await pause(ctx, AFTER_READING);
  return result;
}

async function interact(ctx: BrowseContext): Promise<void> {
  throwIfAborted(ctx.signal);
  await untilTarget(ctx, (s) => ctx.forum.performActions(ctx.policy, s, ctx.signal));
  emitStats(ctx);
}

/** Back to the list, which also gives the site its final `/topics/timings` flush. */
async function leave(ctx: BrowseContext, visit: TopicVisit, readResult: ReadResult | null): Promise<void> {
  const topicId = visit.topic.id;
  const verification = await ctx.forum.returnAndVerify(visit, ctx.signal);
  ctx.stats.returns[verification]++;
  ctx.emit({ type: 'topic', at: timestamp(ctx), topicId, phase: 'returned', result: verification });
  if (verification === 'still-unread') warn(ctx, 'still-unread', `Topic ${topicId} still shows the new-topic badge; the site may not have counted the visit`);
  const floors = readResult && readResult.startFloor !== null && readResult.endFloor !== null ? { floors: { from: readResult.startFloor, to: readResult.endFloor } } : {};
  if (ctx.ledger) {
    ctx.ledger.record({ topicId, lastVisitAt: timestamp(ctx), entered: true, verification, ...floors });
    // Saved after every topic, so a crash or a killed process loses at most the topic in progress.
    await ctx.ledger.save().catch((err: unknown) => warn(ctx, 'ledger-save-failed', toFailure(err).message));
  }
  emitStats(ctx);
}

/**
 * One topic from click to return; true when the topic was entered. Returning runs even when the
 * target was met inside the topic.
 */
async function visitTopic(ctx: BrowseContext, topic: TopicCandidate): Promise<boolean> {
  const visit = await enter(ctx, topic);
  if (!visit) return false;
  ctx.topicId = topic.id;
  try {
    const readResult = reached(ctx) ? null : await read(ctx, visit);
    if (!reached(ctx) && (ctx.liking || ctx.replying)) await interact(ctx);
    await leave(ctx, visit, readResult);
  } finally {
    ctx.topicId = null;
  }
  return true;
}

function pick(ctx: BrowseContext, topics: TopicCandidate[], unreadPosts: boolean): TopicCandidate[] {
  const { preset, ledger, deps } = ctx;
  const candidates = selectCandidates(topics, deps.random, { unreadPosts });
  if (preset.experiments.smartRanked && ledger) return rankTopics(candidates, ledger, deps.clock.now(), deps.random, preset.samplePerCategory);
  return sampleTopics(candidates, deps.random, preset.samplePerCategory);
}

/**
 * The `browsing` state: rounds over the enabled categories until the target is reached, the user
 * stops, or a whole round enters no topic. Endless mode only ends on stop. Category order is
 * reshuffled every round.
 */
export async function browse(input: BrowseInput): Promise<BrowseOutcome> {
  const { preset } = input.plan;
  const { experiments, extraWait } = preset;
  const deadline = armDeadline(preset.runMode, input.deps, input.signal);
  const ctx: BrowseContext = {
    preset,
    forum: input.forum,
    deps: input.deps,
    signal: input.signal,
    deadline: deadline.signal,
    inTopic: AbortSignal.any([input.signal, deadline.signal]),
    emit: input.emit,
    stats: emptyStats(),
    startedAt: input.deps.clock.monotonic(),
    timings: input.timings,
    ledger: input.ledger,
    policy: Object.freeze({
      ...structuredClone(preset.interaction),
      extraWait: { ...extraWait },
      liking: () => ctx.liking,
      replying: () => ctx.replying,
      disableReplies: () => {
        ctx.replying = false;
      },
      onAction: (report: ActionReport) => onAction(ctx, report),
    }),
    liking: preset.interaction.like.enabled,
    replying: preset.interaction.reply.enabled,
    likeRejections: 0,
    topicId: null,
    repliedTopics: new Set(),
  };
  const strategy: TopicStrategy = {
    browseMode: preset.browseMode,
    lists: [...(experiments.useNewList ? (['new'] as const) : []), ...(experiments.useUnreadList ? (['unread'] as const) : [])],
  };
  const { signal } = ctx;

  try {
    for (;;) {
      let enteredThisRound = 0;
      for (const category of shuffle(input.categories, ctx.deps.random)) {
        checkpoint(ctx);
        const batch = await ctx.forum.collectTopics(category, strategy, signal);
        if (batch.topics.length === 0) warn(ctx, 'empty-category', `${category.path} rendered no topic rows`);
        for (const topic of pick(ctx, batch.topics, batch.source === 'unread')) {
          // A time target can run out during a pause; no topic is entered after that.
          checkpoint(ctx);
          if (await visitTopic(ctx, topic)) enteredThisRound++;
          if (extraWait.enabled) {
            checkpoint(ctx);
            await pause(ctx, BETWEEN_TOPICS);
          }
        }
        checkpoint(ctx);
        if (extraWait.enabled) await pause(ctx, { minSec: extraWait.minSec + 1, maxSec: extraWait.maxSec + 2 });
      }
      if (enteredThisRound === 0) return { end: 'no-progress', stats: finalStats(ctx) };
    }
  } catch (err) {
    if (err === TARGET_REACHED) return { end: 'target-reached', stats: finalStats(ctx) };
    if (isAbortError(err)) return { end: 'cancelled', stats: finalStats(ctx) };
    return { end: 'error', stats: finalStats(ctx), failure: toFailure(err) };
  } finally {
    deadline.disarm();
  }
}
