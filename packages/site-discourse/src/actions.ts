import { pauseBetween, throwIfAborted, untilAbort, type ActionPolicy, type RandomSource, type RuntimeDeps } from '@disco-lurk/core';
import { pollUntil } from './auth';
import type { ReadOnlyPage } from './page';
import { EDITOR_KINDS, editorKindFromCounts, type EditorKind } from './parse';
import { COMPOSER_OPEN, EDITOR_SELECTORS, LIKED_MARKERS, likeButtonOf, postOf, SELECTORS } from './selectors';

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

/**
 * What interacting needs from a topic page; tests drive `performActions` through a scripted one.
 * Every method that sends input checks `signal` on entry and stops waiting once it aborts.
 */
export interface ActionSurface {
  postsInViewport(): Promise<number[]>;
  hasLikeButton(postNumber: number): Promise<boolean>;
  isLiked(postNumber: number): Promise<boolean>;
  /** Scrolls back up until floor 1's like button is rendered; false when it never is. */
  scrollToFirstPost(signal: AbortSignal): Promise<boolean>;
  /** Centres the floor's like button, lets the page settle, and presses it. */
  like(postNumber: number, signal: AbortSignal): Promise<void>;
  /** Opens the composer and reports which editor it shows; null when none appeared. */
  openComposer(signal: AbortSignal): Promise<EditorKind | null>;
  /** Types the text, pauses as a person would before sending, and submits. */
  compose(kind: EditorKind, text: string, signal: AbortSignal): Promise<void>;
  composerOpen(): Promise<boolean>;
  /** Throws an open draft away; runs to the end even after a stop. */
  discardComposer(): Promise<void>;
}

/** Field-tested pacing for interactions; none of it shortens when the page is fast. */
export const LIKE = { centerMs: 300, afterSec: [0.8, 1.5], confirmMs: 5_000, pollMs: 250 } as const;
export const REPLY = { editorMs: 10_000, editorSettleSec: [0.5, 1], afterFillSec: [0.8, 1.5], afterSubmitSec: [1, 2], confirmMs: 10_000, pollMs: 500 } as const;
export const FIRST_POST = { stepPx: -2500, settleMs: 400, maxSteps: 40 } as const;

/** Draws reply texts at random, each at most once; null once every template has been used. */
export function templatePicker(templates: readonly string[], random: RandomSource): () => string | null {
  const unused = [...templates];
  return () => {
    if (unused.length === 0) return null;
    return unused.splice(Math.floor(random.next() * unused.length), 1)[0]!;
  };
}

export interface ActionContext {
  /** The next reply text; null when no template is left to use. */
  nextTemplate(): string | null;
  warn(code: string, message: string): void;
}

interface ActionRun {
  surface: ActionSurface;
  policy: ActionPolicy;
  deps: RuntimeDeps;
  ctx: ActionContext;
  signal: AbortSignal;
}

const pause = (run: ActionRun, range: readonly [number, number]) => pauseBetween(run.deps, range[0], range[1], run.signal);

async function rest(run: ActionRun): Promise<void> {
  const { extraWait } = run.policy;
  if (extraWait.enabled) await pause(run, [extraWait.minSec, extraWait.maxSec]);
}

/** Polls `check` on the injected clock until it holds; false once `ms` passes without it. */
async function confirmed(run: ActionRun, check: () => Promise<boolean>, ms: number, every: number): Promise<boolean> {
  const { clock, sleeper } = run.deps;
  return (await pollUntil({ intervalMs: every, timeoutMs: ms, clock, sleeper }, async () => ((await check()) ? true : null), run.signal)) !== null;
}

async function like(run: ActionRun, postNumber: number, bucket: 'topic' | 'reply'): Promise<void> {
  const { surface, policy } = run;
  if (!policy.liking()) return;
  if (!(await surface.hasLikeButton(postNumber))) return;
  // A liked floor's button would take the like back, so it is never pressed.
  if (await surface.isLiked(postNumber)) return;
  await surface.like(postNumber, run.signal);
  policy.onAction({ action: 'like', bucket, result: 'attempted', postNumber });
  const ok = await confirmed(run, () => surface.isLiked(postNumber), LIKE.confirmMs, LIKE.pollMs);
  policy.onAction({ action: 'like', bucket, result: ok ? 'confirmed' : 'rejected', postNumber });
  await pause(run, LIKE.afterSec);
  await rest(run);
}

async function reply(run: ActionRun): Promise<void> {
  const { surface, policy, ctx } = run;
  const text = ctx.nextTemplate();
  if (text === null) {
    ctx.warn('reply-templates-exhausted', 'Every reply template has been used in this run; no reply is posted');
    return;
  }
  await rest(run);
  const kind = await surface.openComposer(run.signal);
  if (kind === null) {
    ctx.warn('composer-missing', 'The reply composer did not open; no reply is posted for this topic');
    await surface.discardComposer();
    return;
  }
  try {
    await pause(run, REPLY.editorSettleSec);
    await surface.compose(kind, text, run.signal);
  } catch (err) {
    // A reply stopped after typing leaves no draft behind.
    await surface.discardComposer();
    throw err;
  }
  policy.onAction({ action: 'reply', bucket: 'reply-post', result: 'attempted' });
  const posted = await confirmed(run, async () => !(await surface.composerOpen()), REPLY.confirmMs, REPLY.pollMs);
  policy.onAction({ action: 'reply', bucket: 'reply-post', result: posted ? 'confirmed' : 'rejected' });
  if (!posted) await surface.discardComposer();
  await pause(run, REPLY.afterSubmitSec);
}

/**
 * Likes and the reply for the topic on screen, each reported through `policy.onAction`. Replies on
 * screen are liked first, because going back up to floor 1 scrolls them away; the reply comes before
 * that for the same reason.
 */
export async function performActions(surface: ActionSurface, policy: ActionPolicy, deps: RuntimeDeps, ctx: ActionContext, signal: AbortSignal): Promise<void> {
  const run: ActionRun = { surface, policy, deps, ctx, signal };
  const roll = (percent: number) => deps.random.next() * 100 < percent;
  if (policy.liking()) {
    const onScreen = (await surface.postsInViewport()).filter((n) => n > 1).slice(0, policy.like.maxReplies);
    for (const postNumber of onScreen) if (roll(policy.like.replyRate)) await like(run, postNumber, 'reply');
  }
  if (policy.reply.enabled && roll(policy.reply.rate)) await reply(run);
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

  async isLiked(postNumber: number): Promise<boolean> {
    const post = postOf(postNumber);
    return (await this.page.count(LIKED_MARKERS.map((m) => `${post} ${m.selector}`).join(', '))) > 0;
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

  async like(postNumber: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await untilAbort(this.page.scrollIntoView(likeButtonOf(postNumber)), signal);
    await this.deps.sleeper.sleep(LIKE.centerMs, signal);
    await untilAbort(this.likeButton.click(postNumber), signal);
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

  async compose(kind: EditorKind, text: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await untilAbort(this.composer.fill(kind, text), signal);
    await pauseBetween(this.deps, REPLY.afterFillSec[0], REPLY.afterFillSec[1], signal);
    await untilAbort(this.composer.submit(), signal);
  }

  async composerOpen(): Promise<boolean> {
    return (await this.page.count(COMPOSER_OPEN)) > 0;
  }

  async discardComposer(): Promise<void> {
    if (await this.composerOpen()) await this.composer.discard();
  }
}
