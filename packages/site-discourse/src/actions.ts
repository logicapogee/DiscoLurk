import { pauseBetween, throwIfAborted, type ActionPolicy, type ActionResult, type RandomSource, type RuntimeDeps } from '@disco-lurk/core';
import type { ReadOnlyPage } from './page';
import { editorKindFromCounts, type EditorKind } from './parse';
import { COMPOSER_OPEN, EDITOR_SELECTORS, likeButtonOf, postOf, SELECTORS } from './selectors';

/** Presses one post's like button. Built in session.ts; nothing else can press it. */
export interface LikeButton {
  click(postNumber: number): Promise<void>;
}

/** The reply composer's four inputs. Built in session.ts; nothing else can type into the site. */
export interface Composer {
  open(): Promise<void>;
  fill(kind: EditorKind, text: string): Promise<void>;
  submit(): Promise<void>;
  /** Throws the draft away, confirming Discourse's discard prompt when it asks. */
  discard(): Promise<void>;
}

/** What interacting needs from a topic page; tests drive `performActions` through a scripted one. */
export interface ActionSurface {
  postsInViewport(): Promise<number[]>;
  hasLikeButton(postNumber: number): Promise<boolean>;
  isLiked(postNumber: number): Promise<boolean>;
  /** Scrolls back up until floor 1's like button is rendered; false when it never is. */
  scrollToFirstPost(signal: AbortSignal): Promise<boolean>;
  centerLikeButton(postNumber: number): Promise<void>;
  clickLike(postNumber: number): Promise<void>;
  /** True once the floor shows either liked marker within the confirmation window. */
  awaitLiked(postNumber: number, signal: AbortSignal): Promise<boolean>;
  /** Opens the composer and reports which editor it shows; null when none appeared. */
  openComposer(signal: AbortSignal): Promise<EditorKind | null>;
  fillComposer(kind: EditorKind, text: string): Promise<void>;
  submitComposer(): Promise<void>;
  /** True once the composer closed after submitting, within the confirmation window. */
  awaitReplyPosted(signal: AbortSignal): Promise<boolean>;
  discardComposer(): Promise<void>;
}

/** Field-tested pacing for interactions; none of it shortens when the page is fast. */
export const LIKE = { centerMs: 300, afterSec: [0.8, 1.5], confirmMs: 5_000, pollMs: 250, limitAfter: 2 } as const;
export const REPLY = { editorMs: 10_000, editorSettleSec: [0.5, 1], afterFillSec: [0.8, 1.5], afterSubmitSec: [1, 2], confirmMs: 10_000, pollMs: 500 } as const;
export const FIRST_POST = { stepPx: -2500, settleMs: 400, maxSteps: 40 } as const;

/**
 * Unconfirmed likes in a row across a run's topics. Discourse's daily like limit shows up as likes
 * that never turn into the liked state, so two in a row end liking for the run.
 */
export class LikeStreak {
  failures = 0;

  get limitHit(): boolean {
    return this.failures >= LIKE.limitAfter;
  }
}

/** Draws reply texts at random, each at most once; null once every template has been used. */
export function templatePicker(templates: readonly string[], random: RandomSource): () => string | null {
  const unused = [...templates];
  return () => {
    if (unused.length === 0) return null;
    return unused.splice(Math.floor(random.next() * unused.length), 1)[0]!;
  };
}

export interface ActionContext {
  streak: LikeStreak;
  /** The next reply text; null when no template is left to use. */
  nextTemplate(): string | null;
  warn(code: string, message: string): void;
}

const blank = () => ({ attempted: 0, confirmed: 0 });

/**
 * Likes and the reply for the topic on screen. Replies on screen are liked first, because going
 * back up to floor 1 scrolls them away; the reply comes before that for the same reason. The stop
 * signal is checked before every action, and a reply interrupted after typing is discarded.
 */
export async function performActions(
  surface: ActionSurface,
  policy: ActionPolicy,
  deps: RuntimeDeps,
  ctx: ActionContext,
  signal: AbortSignal,
): Promise<ActionResult> {
  const result: ActionResult = { likes: blank(), replyLikes: blank(), replies: blank(), likeLimitHit: ctx.streak.limitHit };
  const roll = (percent: number) => deps.random.next() * 100 < percent;
  const pause = (range: readonly [number, number]) => pauseBetween(deps, range[0], range[1], signal);
  const rest = async () => {
    if (policy.extraWait.enabled) await pause([policy.extraWait.minSec, policy.extraWait.maxSec]);
  };

  const like = async (postNumber: number, bucket: { attempted: number; confirmed: number }) => {
    throwIfAborted(signal);
    if (ctx.streak.limitHit) return;
    if (!(await surface.hasLikeButton(postNumber))) return;
    // A liked floor's button would take the like back, so it is never pressed.
    if (await surface.isLiked(postNumber)) return;
    await surface.centerLikeButton(postNumber);
    await deps.sleeper.sleep(LIKE.centerMs, signal);
    throwIfAborted(signal);
    await surface.clickLike(postNumber);
    bucket.attempted++;
    policy.onAction({ action: 'like', result: 'attempted', postNumber });
    if (await surface.awaitLiked(postNumber, signal)) {
      bucket.confirmed++;
      ctx.streak.failures = 0;
      policy.onAction({ action: 'like', result: 'confirmed', postNumber });
    } else {
      ctx.streak.failures++;
      policy.onAction({ action: 'like', result: 'rejected', postNumber });
    }
    await pause(LIKE.afterSec);
    await rest();
  };

  const reply = async () => {
    const text = ctx.nextTemplate();
    if (text === null) {
      ctx.warn('reply-templates-exhausted', 'Every reply template has been used in this run; no reply is posted');
      return;
    }
    await rest();
    throwIfAborted(signal);
    const kind = await surface.openComposer(signal);
    if (kind === null) {
      ctx.warn('composer-missing', 'The reply composer did not open; no reply is posted for this topic');
      await surface.discardComposer();
      return;
    }
    try {
      await pause(REPLY.editorSettleSec);
      await surface.fillComposer(kind, text);
      await pause(REPLY.afterFillSec);
      throwIfAborted(signal);
    } catch (err) {
      await surface.discardComposer();
      throw err;
    }
    await surface.submitComposer();
    result.replies.attempted++;
    policy.onAction({ action: 'reply', result: 'attempted' });
    if (await surface.awaitReplyPosted(signal)) {
      result.replies.confirmed++;
      policy.onAction({ action: 'reply', result: 'confirmed' });
    } else {
      policy.onAction({ action: 'reply', result: 'rejected' });
      await surface.discardComposer();
    }
    await pause(REPLY.afterSubmitSec);
  };

  if (policy.like.enabled) {
    const onScreen = (await surface.postsInViewport()).filter((n) => n > 1).slice(0, policy.like.maxReplies);
    for (const postNumber of onScreen) if (roll(policy.like.replyRate)) await like(postNumber, result.replyLikes);
  }
  if (policy.reply.enabled && roll(policy.reply.rate)) await reply();
  if (policy.like.enabled && !ctx.streak.limitHit && roll(policy.like.topicRate)) {
    throwIfAborted(signal);
    if (await surface.scrollToFirstPost(signal)) await like(1, result.likes);
    else ctx.warn('first-post-missing', 'Floor 1 never rendered its like button while scrolling back up; the topic is not liked');
  }
  result.likeLimitHit = ctx.streak.limitHit;
  return result;
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

  private count(selector: string): Promise<number> {
    return this.page.count(selector);
  }

  /** Polls `check` until it holds or `ms` passes on the injected clock. */
  private async poll(check: () => Promise<boolean>, ms: number, every: number, signal: AbortSignal): Promise<boolean> {
    const until = this.deps.clock.monotonic() + ms;
    for (;;) {
      if (await check()) return true;
      if (this.deps.clock.monotonic() >= until) return false;
      await this.deps.sleeper.sleep(every, signal);
    }
  }

  postsInViewport(): Promise<number[]> {
    return this.page.postsInViewport();
  }

  async hasLikeButton(postNumber: number): Promise<boolean> {
    return (await this.count(likeButtonOf(postNumber))) > 0;
  }

  async isLiked(postNumber: number): Promise<boolean> {
    const post = postOf(postNumber);
    const [reacted, icon] = await Promise.all([this.count(`${post} ${SELECTORS.likedReacted}`), this.count(`${post} ${SELECTORS.likedIcon}`)]);
    return reacted > 0 || icon > 0;
  }

  async scrollToFirstPost(signal: AbortSignal): Promise<boolean> {
    const { width, height } = await this.page.viewportSize();
    await this.page.moveMouse(Math.round(width / 2), Math.round(height / 2));
    for (let step = 0; step <= FIRST_POST.maxSteps; step++) {
      if (await this.hasLikeButton(1)) {
        // `#post_1` is only a cross-check: on a cloaked topic it is an empty placeholder outside floor 1.
        if ((await this.count(`${postOf(1)} ${SELECTORS.firstPostById}`)) === 0) {
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

  centerLikeButton(postNumber: number): Promise<void> {
    return this.page.scrollIntoView(likeButtonOf(postNumber));
  }

  clickLike(postNumber: number): Promise<void> {
    return this.likeButton.click(postNumber);
  }

  awaitLiked(postNumber: number, signal: AbortSignal): Promise<boolean> {
    return this.poll(() => this.isLiked(postNumber), LIKE.confirmMs, LIKE.pollMs, signal);
  }

  private async editor(): Promise<EditorKind | null> {
    const [textarea, dEditor, prosemirror] = await Promise.all([
      this.count(EDITOR_SELECTORS.textarea),
      this.count(EDITOR_SELECTORS['d-editor-input']),
      this.count(EDITOR_SELECTORS.prosemirror),
    ]);
    return editorKindFromCounts({ textarea, 'd-editor-input': dEditor, prosemirror });
  }

  async openComposer(signal: AbortSignal): Promise<EditorKind | null> {
    await this.composer.open();
    let kind: EditorKind | null = null;
    await this.poll(async () => (kind = await this.editor()) !== null, REPLY.editorMs, REPLY.pollMs, signal);
    return kind;
  }

  fillComposer(kind: EditorKind, text: string): Promise<void> {
    return this.composer.fill(kind, text);
  }

  submitComposer(): Promise<void> {
    return this.composer.submit();
  }

  awaitReplyPosted(signal: AbortSignal): Promise<boolean> {
    return this.poll(async () => (await this.count(COMPOSER_OPEN)) === 0, REPLY.confirmMs, REPLY.pollMs, signal);
  }

  async discardComposer(): Promise<void> {
    if ((await this.count(COMPOSER_OPEN)) > 0) await this.composer.discard();
  }
}
