import { isAbortError, pauseWithin, throwIfAborted, untilAbort, type ActionPolicy, type InterruptibleSleeper, type RandomSource, type RuntimeDeps, type WaitRange } from '@disco-lurk/core';
import { pollUntil, waitUntil } from './auth';
import type { ReadOnlyPage } from './page';
import { EDITOR_KINDS, editorKindFromCounts, type EditorKind } from './parse';
import { COMPOSER_OPEN, EDITOR_SELECTORS, LIKED_MARKERS, likeButtonOf, postOf, SELECTORS, UNLIKED_ICON } from './selectors';

/** Presses one post's like button. Built in session.ts, the one place that holds a clickable page. */
export interface LikeButton {
  click(postNumber: number): Promise<void>;
}

/** The reply composer's inputs and the site's answer to them. Built in session.ts, the one place that holds a clickable page. */
export interface Composer {
  open(): Promise<void>;
  fill(kind: EditorKind, text: string): Promise<void>;
  submit(): Promise<void>;
  /** Throws the draft away, confirming Discourse's discard prompt when it asks. */
  discard(): Promise<void>;
  /** How many `POST /posts` the site has answered with success on this page so far. */
  postsAcknowledged(): number;
}

/** `liked` on either liked marker; `unliked` only on the unliked icon; `unknown` when neither shows. */
export type LikeState = 'liked' | 'unliked' | 'unknown';

/**
 * What interacting needs from a topic page; tests drive `performActions` through a scripted one.
 * Methods that take a signal check it on entry and stop waiting once it aborts; the two presses
 * that send something to the site take none and end by their own click timeout.
 */
export interface ActionSurface {
  postsInViewport(): Promise<number[]>;
  hasLikeButton(postNumber: number): Promise<boolean>;
  likeState(postNumber: number): Promise<LikeState>;
  /** Scrolls back up until floor 1's like button is rendered; false when it never is. */
  scrollToFirstPost(signal: AbortSignal): Promise<boolean>;
  /** Scrolls the floor's like button to the middle of the viewport and lets the page settle. */
  centerLikeButton(postNumber: number, signal: AbortSignal): Promise<void>;
  pressLike(postNumber: number): Promise<void>;
  /** Whether the topic's own reply button is rendered; a long topic shows it only once read to its end. */
  hasReplyButton(): Promise<boolean>;
  /** Whether the composer is open or minimised to a draft. */
  composerOpen(): Promise<boolean>;
  /** Opens the composer and reports which editor it shows; null when none appeared. */
  openComposer(signal: AbortSignal): Promise<EditorKind | null>;
  fill(kind: EditorKind, text: string, signal: AbortSignal): Promise<void>;
  submitReply(): Promise<void>;
  postsAcknowledged(): number;
  /** Throws the draft away and checks the composer closed; false when it is still open or draft once the check runs out. */
  discardComposer(signal: AbortSignal): Promise<boolean>;
}

/** Field-tested pacing for interactions, the same however fast the page answers. */
export const LIKE = { centerMs: 300, after: { minSec: 0.8, maxSec: 1.5 }, confirmMs: 5_000, pollMs: 250 } as const;
export const REPLY = {
  editorMs: 10_000,
  editorSettle: { minSec: 0.5, maxSec: 1 },
  afterFill: { minSec: 0.8, maxSec: 1.5 },
  afterSubmit: { minSec: 1, maxSec: 2 },
  confirmMs: 10_000,
  pollMs: 500,
} as const;
/** A discarded draft must leave the composer closed within `verifyMs`; after a stop the whole discard gets `afterStopMs`. */
export const DISCARD = { verifyMs: 3_000, pollMs: 250, afterStopMs: 2_000 } as const;
export const FIRST_POST = { stepPx: -2500, settleMs: 400, maxSteps: 40 } as const;

/** Draws reply texts at random, each at most once; null once every template has been used. */
export function templatePicker(templates: readonly string[], random: RandomSource): () => string | null {
  const unused = [...templates];
  return () => {
    if (unused.length === 0) return null;
    return unused.splice(Math.floor(random.next() * unused.length), 1)[0]!;
  };
}

interface ActionContext {
  /** The next reply text; null when no template is left to use. */
  nextTemplate(): string | null;
  warn(code: string, message: string): void;
}

interface ActionRun {
  surface: ActionSurface;
  policy: ActionPolicy;
  deps: RuntimeDeps;
  ctx: ActionContext;
  /** Stop requests and the time target. */
  signal: AbortSignal;
  /** Stop requests alone. */
  stop: AbortSignal;
}

const timedOut = (err: unknown) => err instanceof Error && err.name === 'TimeoutError';

const pause = (run: ActionRun, range: WaitRange) => pauseWithin(run.deps, range, run.signal);

async function rest(run: ActionRun): Promise<void> {
  const { extraWait } = run.policy;
  if (extraWait.enabled) await pause(run, extraWait);
}

/**
 * Whether `check` holds within `ms`. Only a stop request ends the wait early: a press already
 * sent is confirmed to the end of its window even when the time target runs out meanwhile.
 */
function holdsWithin(run: ActionRun, check: () => Promise<boolean>, ms: number, every: number): Promise<boolean> {
  const { clock, sleeper } = run.deps;
  return waitUntil({ intervalMs: every, timeoutMs: ms, clock, sleeper }, check, run.stop);
}

/**
 * A signal that aborts `ms` after `stop` does (at once if it already has), so work that must
 * outlive a stop still ends within a fixed time of it. `release` drops the timer.
 */
function graceAfter(stop: AbortSignal, ms: number, sleeper: InterruptibleSleeper): { signal: AbortSignal; release(): void } {
  const expired = new AbortController();
  const released = new AbortController();
  const start = () => {
    sleeper.sleep(ms, released.signal).then(
      () => expired.abort(stop.reason),
      (err: unknown) => {
        if (!isAbortError(err)) throw err;
      },
    );
  };
  if (stop.aborted) start();
  else stop.addEventListener('abort', start, { once: true });
  return {
    signal: expired.signal,
    release: () => {
      stop.removeEventListener('abort', start);
      released.abort();
    },
  };
}

async function like(run: ActionRun, postNumber: number, bucket: 'topic' | 'reply'): Promise<void> {
  const { surface, policy, ctx } = run;
  if (!policy.liking() || !(await surface.hasLikeButton(postNumber))) return;
  if ((await surface.likeState(postNumber)) === 'liked') return;
  try {
    await surface.centerLikeButton(postNumber, run.signal);
  } catch (err) {
    if (!timedOut(err)) throw err;
    ctx.warn('like-timeout', `Floor ${postNumber}'s like button could not be scrolled to; it is not liked`);
    return;
  }
  // Read again right before pressing: only the unliked icon proves the press adds a like rather than taking one back.
  const state = await surface.likeState(postNumber);
  if (state !== 'unliked') {
    if (state === 'unknown') ctx.warn('like-state-unknown', `Floor ${postNumber} shows neither the liked nor the unliked icon; it is not liked`);
    return;
  }
  throwIfAborted(run.signal);
  policy.onAction({ action: 'like', bucket, result: 'attempted', postNumber });
  let liked = false;
  try {
    await surface.pressLike(postNumber);
    liked = await holdsWithin(run, async () => (await surface.likeState(postNumber)) === 'liked', LIKE.confirmMs, LIKE.pollMs);
  } catch (err) {
    if (!timedOut(err)) throw err;
    ctx.warn('like-timeout', `Pressing floor ${postNumber}'s like button timed out`);
  }
  policy.onAction({ action: 'like', bucket, result: liked ? 'confirmed' : 'rejected', postNumber });
  await pause(run, LIKE.after);
  await rest(run);
}

/**
 * Throws the draft away. After a stop the whole discard has `DISCARD.afterStopMs`. A composer still
 * open or draft afterwards turns replies off for the run, since the next topic would open onto it.
 */
async function discard(run: ActionRun): Promise<void> {
  const grace = graceAfter(run.stop, DISCARD.afterStopMs, run.deps.sleeper);
  let closed = false;
  try {
    closed = await run.surface.discardComposer(grace.signal);
  } catch (err) {
    if (!isAbortError(err) && !timedOut(err)) throw err;
  } finally {
    grace.release();
  }
  if (closed) return;
  run.ctx.warn('composer-stuck', 'The reply draft could not be discarded; replies are off for the rest of this run');
  run.policy.disableReplies();
}

async function reply(run: ActionRun): Promise<void> {
  const { surface, policy, ctx } = run;
  const text = ctx.nextTemplate();
  if (text === null) {
    ctx.warn('reply-templates-exhausted', 'Every reply template has been used in this run; no reply is posted');
    return;
  }
  if (!(await surface.hasReplyButton())) {
    ctx.warn('reply-button-missing', "The topic's reply button is not rendered (a long topic not read to its end); no reply is posted for this topic");
    return;
  }
  await rest(run);
  // A composer already open or minimised holds a draft that is not this run's to type into or throw away.
  if (await surface.composerOpen()) {
    ctx.warn('composer-busy', 'The composer is already open or holds a minimised draft; no reply is posted for this topic');
    return;
  }
  let posted = false;
  try {
    const kind = await surface.openComposer(run.signal);
    if (kind === null) {
      ctx.warn('composer-missing', 'The reply composer did not open; no reply is posted for this topic');
      return;
    }
    await pause(run, REPLY.editorSettle);
    await surface.fill(kind, text, run.signal);
    await pause(run, REPLY.afterFill);
    throwIfAborted(run.signal);
    const before = surface.postsAcknowledged();
    policy.onAction({ action: 'reply', bucket: 'reply-post', result: 'attempted' });
    try {
      await surface.submitReply();
      // Posted means the site acknowledged a new post and the composer closed.
      posted = await holdsWithin(run, async () => surface.postsAcknowledged() > before && !(await surface.composerOpen()), REPLY.confirmMs, REPLY.pollMs);
    } catch (err) {
      if (!timedOut(err)) throw err;
      ctx.warn('reply-timeout', 'Pressing the reply button timed out');
    }
    policy.onAction({ action: 'reply', bucket: 'reply-post', result: posted ? 'confirmed' : 'rejected' });
  } catch (err) {
    if (!timedOut(err)) throw err;
    ctx.warn('reply-timeout', 'The composer did not respond in time; no reply is posted for this topic');
  } finally {
    // Whatever ended the reply, a draft that was not posted is thrown away.
    if (!posted) await discard(run);
  }
  await pause(run, REPLY.afterSubmit);
}

/**
 * Likes and the reply for the topic on screen, each reported through `policy.onAction`. Replies on
 * screen are liked first, because going back up to floor 1 scrolls them away; the reply comes before
 * that for the same reason.
 */
export async function performActions(surface: ActionSurface, policy: ActionPolicy, deps: RuntimeDeps, ctx: ActionContext, signal: AbortSignal, stop: AbortSignal): Promise<void> {
  const run: ActionRun = { surface, policy, deps, ctx, signal, stop };
  const roll = (percent: number) => deps.random.next() * 100 < percent;
  if (policy.liking()) {
    const onScreen = (await surface.postsInViewport()).filter((n) => n > 1).slice(0, policy.like.maxReplies);
    for (const postNumber of onScreen) if (roll(policy.like.replyRate)) await like(run, postNumber, 'reply');
  }
  if (policy.replying() && roll(policy.reply.rate)) await reply(run);
  if (policy.liking() && roll(policy.like.topicRate)) {
    if (await surface.scrollToFirstPost(signal)) await like(run, 1, 'topic');
    else ctx.warn('first-post-missing', 'Floor 1 never rendered its like button while scrolling back up; the topic is not liked');
  }
}

/** The `ActionSurface` of a live topic page: reads through `ReadOnlyPage`, presses only the two narrow inputs. */
export class PageActionSurface implements ActionSurface {
  constructor(
    private readonly page: ReadOnlyPage,
    private readonly likeButton: LikeButton,
    private readonly composer: Composer,
    private readonly deps: RuntimeDeps,
    private readonly warn: (code: string, message: string) => void,
  ) {}

  postsInViewport(): Promise<number[]> {
    return this.page.postsInViewport();
  }

  async hasLikeButton(postNumber: number): Promise<boolean> {
    return (await this.page.count(likeButtonOf(postNumber))) > 0;
  }

  async likeState(postNumber: number): Promise<LikeState> {
    const post = postOf(postNumber);
    const [liked = 0, unliked = 0] = await this.page.counts([LIKED_MARKERS.map((m) => `${post} ${m.selector}`).join(', '), `${post} ${UNLIKED_ICON}`]);
    if (liked > 0) return 'liked';
    return unliked > 0 ? 'unliked' : 'unknown';
  }

  async scrollToFirstPost(signal: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const { width, height } = await this.page.viewportSize();
    await this.page.moveMouse(Math.round(width / 2), Math.round(height / 2));
    for (let step = 0; step <= FIRST_POST.maxSteps; step++) {
      if (await this.hasLikeButton(1)) {
        // `#post_1` is only a cross-check: on a cloaked topic it is an empty placeholder outside floor 1.
        if ((await this.page.count(`${postOf(1)} ${SELECTORS.firstPostById}`)) === 0) {
          this.warn('first-post-unverified', 'Floor 1 rendered without #post_1 inside it');
        }
        return true;
      }
      if (step === FIRST_POST.maxSteps) break;
      await this.page.wheel(0, FIRST_POST.stepPx);
      await this.deps.sleeper.sleep(FIRST_POST.settleMs, signal);
    }
    return false;
  }

  async centerLikeButton(postNumber: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await untilAbort(this.page.centerInViewport(likeButtonOf(postNumber)), signal);
    await this.deps.sleeper.sleep(LIKE.centerMs, signal);
  }

  pressLike(postNumber: number): Promise<void> {
    return this.likeButton.click(postNumber);
  }

  async hasReplyButton(): Promise<boolean> {
    return (await this.page.count(SELECTORS.replyOpen)) > 0;
  }

  async composerOpen(): Promise<boolean> {
    return (await this.page.count(COMPOSER_OPEN)) > 0;
  }

  private async editor(): Promise<EditorKind | null> {
    return editorKindFromCounts(await this.page.counts(EDITOR_KINDS.map((kind) => EDITOR_SELECTORS[kind])));
  }

  async openComposer(signal: AbortSignal): Promise<EditorKind | null> {
    throwIfAborted(signal);
    await untilAbort(this.composer.open(), signal);
    const { clock, sleeper } = this.deps;
    return pollUntil({ intervalMs: REPLY.pollMs, timeoutMs: REPLY.editorMs, clock, sleeper }, () => this.editor(), signal);
  }

  async fill(kind: EditorKind, text: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await untilAbort(this.composer.fill(kind, text), signal);
  }

  submitReply(): Promise<void> {
    return this.composer.submit();
  }

  postsAcknowledged(): number {
    return this.composer.postsAcknowledged();
  }

  async discardComposer(signal: AbortSignal): Promise<boolean> {
    if (!(await this.composerOpen())) return true;
    await untilAbort(this.composer.discard(), signal);
    const { clock, sleeper } = this.deps;
    return waitUntil({ intervalMs: DISCARD.pollMs, timeoutMs: DISCARD.verifyMs, clock, sleeper }, async () => !(await this.composerOpen()), signal);
  }
}
