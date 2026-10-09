import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seededRandom, type ActionPolicy, type ActionReport, type InteractionPolicy } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { DISCARD, FIRST_POST, LIKE, PageActionSurface, performActions, REPLY, templatePicker, type ActionSurface, type Composer, type LikeState } from './actions';
import type { EditorKind } from './parse';
import { likeButtonOf } from './selectors';
import { StaticPage, timeoutError } from './testing';
import { WHEEL } from './wheel';

const OFF: InteractionPolicy = { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5, riskAcknowledged: false } };
const REPLY_ON = { enabled: true, rate: 100, riskAcknowledged: true };

const fixture = (site: string, file: string) => readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/${site}/${file}`, import.meta.url)), 'utf8');

/** A policy whose switches are the preset's; `liking` overrides the like switch, as the kernel's like limit would. */
function policy(over: { like?: Partial<InteractionPolicy['like']>; reply?: Partial<InteractionPolicy['reply']>; extraWait?: boolean; liking?: () => boolean } = {}) {
  const reports: ActionReport[] = [];
  const like = { ...OFF.like, ...over.like };
  const reply = { ...OFF.reply, ...over.reply };
  const state = { replying: reply.enabled };
  const p: ActionPolicy = {
    like,
    reply,
    extraWait: { enabled: over.extraWait ?? false, minSec: 1, maxSec: 3 },
    liking: over.liking ?? (() => like.enabled),
    replying: () => state.replying,
    disableReplies: () => {
      state.replying = false;
    },
    onAction: (r) => reports.push(r),
  };
  return { p, reports, state };
}

/** Attempted and confirmed counts per bucket, as the kernel would add them up. */
function tally(reports: readonly ActionReport[], bucket: ActionReport['bucket']) {
  const of = (result: ActionReport['result']) => reports.filter((r) => r.bucket === bucket && r.result === result).length;
  return { attempted: of('attempted'), confirmed: of('confirmed') };
}

interface Script {
  viewport?: number[];
  liked?: number[];
  /** Floors that show neither like icon. */
  unknown?: number[];
  /** Floors whose like button exists; all floors by default. */
  buttons?: number[];
  /** Whether a press on this floor turns into the liked state. */
  confirms?: (post: number) => boolean;
  /** Virtual milliseconds a like press takes. */
  pressMs?: number;
  pressFails?: Error;
  firstPostRenders?: boolean;
  replyButton?: boolean;
  /** The composer is open or draft before anything is pressed. */
  composerBusy?: boolean;
  editor?: EditorKind | null;
  openFails?: Error;
  submitFails?: Error;
  /** Whether submitting gets the site's acknowledgement, and whether it closes the composer; both by default. */
  acknowledged?: boolean;
  closesOnSubmit?: boolean;
  /** Whether discarding closes the composer; true by default. */
  discardCloses?: boolean;
  /** Virtual milliseconds the discard takes. */
  discardMs?: number;
}

/** Records every call with the virtual time it happened at. */
function scripted(time: VirtualTime, s: Script = {}) {
  const calls: Array<{ op: string; arg?: unknown; at: number }> = [];
  const log = (op: string, arg?: unknown): void => void calls.push({ op, ...(arg !== undefined ? { arg } : {}), at: time.clock.monotonic() });
  const liked = new Set(s.liked ?? []);
  let open = s.composerBusy ?? false;
  let acks = 0;
  const never = new AbortController().signal;
  const surface: ActionSurface = {
    postsInViewport: async () => s.viewport ?? [],
    hasLikeButton: async (n) => s.buttons === undefined || s.buttons.includes(n),
    likeState: async (n): Promise<LikeState> => (liked.has(n) ? 'liked' : s.unknown?.includes(n) ? 'unknown' : 'unliked'),
    scrollToFirstPost: async () => {
      log('scrollToFirstPost');
      return s.firstPostRenders ?? true;
    },
    centerLikeButton: async (n) => log('center', n),
    pressLike: async (n) => {
      log('clickLike', n);
      if (s.pressMs) await time.sleeper.sleep(s.pressMs, never);
      if (s.pressFails) throw s.pressFails;
      log('pressed', n);
      if (s.confirms?.(n) ?? true) liked.add(n);
    },
    hasReplyButton: async () => s.replyButton ?? true,
    composerOpen: async () => open,
    openComposer: async () => {
      log('openComposer');
      if (s.openFails) throw s.openFails;
      open = true;
      return s.editor === undefined ? 'textarea' : s.editor;
    },
    fill: async (kind, text) => log('fill', { kind, text }),
    submitReply: async () => {
      log('submit');
      if (s.submitFails) throw s.submitFails;
      if (s.acknowledged ?? true) acks++;
      if (s.closesOnSubmit ?? true) open = false;
    },
    postsAcknowledged: () => acks,
    discardComposer: async (signal) => {
      log('discard');
      if (s.discardMs) await time.sleeper.sleep(s.discardMs, signal);
      if (s.discardCloses ?? true) open = false;
      return !open;
    },
  };
  return { surface, calls, ops: () => calls.map((c) => c.op), clicks: () => calls.filter((c) => c.op === 'clickLike').map((c) => c.arg) };
}

/** `signal` is what cuts the topic short; `stop` defaults to it, as when only stop requests are in play. */
function act(time: VirtualTime, surface: ActionSurface, p: ActionPolicy, opts: { templates?: string[]; signal?: AbortSignal; stop?: AbortSignal; seed?: number } = {}) {
  const warnings: string[] = [];
  const deps = { ...time.deps(), random: seededRandom(opts.seed ?? 1) };
  const ctx = { nextTemplate: templatePicker(opts.templates ?? ['感谢分享，学到了新东西'], deps.random), warn: (c: string) => warnings.push(c) };
  const signal = opts.signal ?? new AbortController().signal;
  const stop = opts.stop ?? signal;
  return { run: () => time.drive(performActions(surface, p, deps, ctx, signal, stop)), warnings };
}

const NO_COMPOSER: Composer = { open: async () => {}, fill: async () => {}, submit: async () => {}, discard: async () => {}, postsAcknowledged: () => 0 };
const pageSurface = (page: StaticPage, time = new VirtualTime(), composer: Composer = NO_COMPOSER, click: (n: number) => Promise<void> = async () => {}) =>
  new PageActionSurface(page, { click }, composer, time.deps(), () => {});

describe('ACTION-000 nothing happens with likes and replies off (A01, A02)', () => {
  it('touches no control', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3] });
    const { p, reports } = policy();
    await act(time, s.surface, p).run();
    expect(s.calls).toEqual([]);
    expect(reports).toEqual([]);
  });
});

describe('LIKE-001 a floor is pressed only on positive evidence that it is unliked (A03)', () => {
  it('skips liked floors and floors without a like button', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3, 4], liked: [2], buttons: [1, 2, 4] });
    await act(time, s.surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } }).p).run();
    expect(s.clicks()).toEqual([4]);
  });

  it('skips a floor showing neither icon and warns, pressing nothing there', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3], unknown: [2] });
    const { p, reports } = policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } });
    const a = act(time, s.surface, p);
    await a.run();
    expect(s.clicks()).toEqual([3]);
    expect(a.warnings).toEqual(['like-state-unknown']);
    expect(reports.filter((r) => r.postNumber === 2)).toEqual([]);
  });

  it('reads the state again after centring and skips a floor that turned out liked', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2] });
    let reads = 0;
    const surface: ActionSurface = { ...s.surface, likeState: async () => (++reads === 1 ? 'unliked' : 'liked') };
    await act(time, surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } }).p).run();
    expect(s.ops()).toEqual(['center']);
    expect(reads).toBe(2);
  });

  const page = (post: string) => new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2">${post}</div>`);

  it.each<[string, string, LikeState]>([
    ['reactions container only', '<div class="discourse-reactions-actions has-reacted has-used-main-reaction"></div>', 'liked'],
    ['liked icon only', '<button class="btn-toggle-reaction-like"><svg class="d-icon-d-liked"></svg></button>', 'liked'],
    ['both markers', '<div class="discourse-reactions-actions has-reacted"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-liked"></svg></button></div>', 'liked'],
    ['reacted container with the unliked icon', '<div class="discourse-reactions-actions has-reacted"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-unliked"></svg></button></div>', 'liked'],
    ['unliked icon', '<div class="discourse-reactions-actions"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-unliked"></svg></button></div>', 'unliked'],
    ['a button with no icon', '<button class="btn-toggle-reaction-like"></button>', 'unknown'],
    ['retired has-used marker only', '<div class="has-used has-like my-likes"></div>', 'unknown'],
  ])('%s → %s', async (_name, html, expected) => {
    await expect(pageSurface(page(html)).likeState(2)).resolves.toBe(expected);
  });

  it.each(['linuxdo', 'docofcard'])('reads the hand-liked floor of the %s fixture as liked and floor 1 as unliked', async (site) => {
    const s = pageSurface(new StaticPage('https://x/t/y/1', fixture(site, 'liked.html')));
    await expect(s.likeState(2)).resolves.toBe('liked');
    await expect(s.likeState(1)).resolves.toBe('unliked');
  });
});

describe('LIKE-002 floor 1 is found by its post number after cloaking; replies on screen, at most 4 (A04)', () => {
  it('likes at most maxReplies floors on screen, never floor 1 among them, then floor 1 after scrolling up', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [1, 5, 6, 7, 8, 9, 10] });
    await act(time, s.surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 100, maxReplies: 4 } }).p).run();
    expect(s.clicks()).toEqual([5, 6, 7, 8, 1]);
    // Floor 1 comes last: scrolling up to it would take the replies on screen away.
    const order = s.calls.filter((c) => c.op === 'clickLike' || c.op === 'scrollToFirstPost').map((c) => c.arg ?? c.op);
    expect(order).toEqual([5, 6, 7, 8, 'scrollToFirstPost', 1]);
  });

  it('scrolls a cloaked long topic back up until floor 1 renders its own like button, then presses that one', async () => {
    const page = new StaticPage('https://linux.do/t/x/2496114/40', fixture('linuxdo', 'topic-wide.html'));
    let scrolled = 0;
    page.onWheel = (dy) => {
      expect(dy).toBeLessThan(0);
      scrolled += dy;
      if (scrolled === 3 * FIRST_POST.stepPx) page.html = fixture('linuxdo', 'liked.html');
    };
    const pressed: number[] = [];
    const time = new VirtualTime();
    const surface = pageSurface(page, time, NO_COMPOSER, async (n) => void pressed.push(n));
    await expect(time.drive(surface.scrollToFirstPost(new AbortController().signal))).resolves.toBe(true);
    expect(scrolled).toBe(3 * FIRST_POST.stepPx);
    await time.drive(surface.centerLikeButton(1, new AbortController().signal));
    await surface.pressLike(1);
    expect(pressed).toEqual([1]);
    expect(page.measured).toEqual([likeButtonOf(1)]);
    expect(page.all(likeButtonOf(1))).toHaveLength(1);
  });

  it('gives up on floor 1 when it never renders and warns, liking nothing there', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { firstPostRenders: false });
    const { p, reports } = policy({ like: { enabled: true, topicRate: 100 } });
    const a = act(time, s.surface, p);
    await a.run();
    expect(reports).toEqual([]);
    expect(a.warnings).toContain('first-post-missing');
  });
});

describe('ACTION-001 a click counts as confirmed only after the page shows it (A05, A07)', () => {
  it('wheels the button to the middle of the viewport in notches, waits 300 ms, then clicks', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2"><button class="btn-toggle-reaction-like"></button></div>`);
    page.offset = 450;
    const notches: number[] = [];
    let lastWheelAt = -1;
    page.onWheel = (dy) => {
      notches.push(dy);
      page.offset -= dy;
      lastWheelAt = time.clock.monotonic();
    };
    let clickedAt = -1;
    const surface = pageSurface(page, time, NO_COMPOSER, async () => void (clickedAt = time.clock.monotonic()));
    await time.drive(surface.centerLikeButton(2, new AbortController().signal));
    await surface.pressLike(2);
    expect(page.offset).toBe(0);
    expect(notches.length).toBeGreaterThan(1);
    for (const dy of notches) expect(dy).toBeLessThanOrEqual(WHEEL.tickPx[1]);
    expect(clickedAt - lastWheelAt).toBe(LIKE.centerMs);
  });

  it('leaves a button already near the middle where it is', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2"><button class="btn-toggle-reaction-like"></button></div>`);
    page.offset = -LIKE.centeredPx;
    let wheels = 0;
    page.onWheel = () => void wheels++;
    await time.drive(pageSurface(page, time).centerLikeButton(2, new AbortController().signal));
    expect(wheels).toBe(0);
  });

  it('reports attempted before the press, then confirmed, in the topic bucket for floor 1', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const { p, reports } = policy({ like: { enabled: true, topicRate: 100 } });
    const seenAtPress: number[] = [];
    const surface: ActionSurface = { ...s.surface, pressLike: async (n) => (seenAtPress.push(reports.length), s.surface.pressLike(n)) };
    await act(time, surface, p).run();
    expect(seenAtPress).toEqual([1]);
    expect(reports).toEqual([
      { action: 'like', bucket: 'topic', result: 'attempted', postNumber: 1 },
      { action: 'like', bucket: 'topic', result: 'confirmed', postNumber: 1 },
    ]);
  });

  it('an unconfirmed like stays attempted and is reported rejected after the 5 s confirmation window', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { confirms: () => false });
    const { p, reports } = policy({ like: { enabled: true, topicRate: 100 } });
    await act(time, s.surface, p).run();
    expect(tally(reports, 'topic')).toEqual({ attempted: 1, confirmed: 0 });
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'rejected']);
    expect(time.clock.monotonic()).toBeGreaterThanOrEqual(LIKE.confirmMs);
  });

  it('a reply is confirmed by the acknowledged POST /posts together with the composer closing', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const { p, reports } = policy({ reply: REPLY_ON });
    await act(time, s.surface, p).run();
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'confirmed']);
    expect(s.ops()).not.toContain('discard');
  });

  it('a composer that closes without the site acknowledging a post is rejected after the 10 s window', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { acknowledged: false });
    const { p, reports } = policy({ reply: REPLY_ON });
    await act(time, s.surface, p).run();
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'rejected']);
    const submitted = s.calls.find((c) => c.op === 'submit')!.at;
    expect(time.clock.monotonic() - submitted).toBeGreaterThanOrEqual(REPLY.confirmMs);
  });

  it('a reply whose composer stays open is attempted, rejected and its draft discarded', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { closesOnSubmit: false });
    const { p, reports } = policy({ reply: REPLY_ON });
    await act(time, s.surface, p).run();
    expect(reports).toEqual([
      { action: 'reply', bucket: 'reply-post', result: 'attempted' },
      { action: 'reply', bucket: 'reply-post', result: 'rejected' },
    ]);
    expect(s.ops()).toEqual(['openComposer', 'fill', 'submit', 'discard']);
  });

  it('the confirmation window runs to its end when only the time target runs out', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { closesOnSubmit: false, acknowledged: false });
    const deadline = new AbortController();
    const { p, reports } = policy({ reply: REPLY_ON });
    const run = act(time, s.surface, p, { signal: deadline.signal, stop: new AbortController().signal }).run();
    time.at(5_000, () => deadline.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const submitted = s.calls.find((c) => c.op === 'submit')!.at;
    expect(submitted).toBeLessThan(5_000);
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'rejected']);
    expect(s.calls.find((c) => c.op === 'discard')!.at - submitted).toBeGreaterThanOrEqual(REPLY.confirmMs);
  });
});

describe('ACTION-002 a step that times out costs that action only (A05)', () => {
  it('a like press that times out is warned, reported rejected, and the next floor is still liked', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3] });
    let presses = 0;
    const surface: ActionSurface = {
      ...s.surface,
      pressLike: async (n) => {
        if (++presses === 1) throw timeoutError('locator.click: Timeout 10000ms exceeded.');
        return s.surface.pressLike(n);
      },
    };
    const { p, reports } = policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } });
    const a = act(time, surface, p);
    await a.run();
    expect(reports.map((r) => `${r.postNumber} ${r.result}`)).toEqual(['2 attempted', '2 rejected', '3 attempted', '3 confirmed']);
    expect(a.warnings).toEqual(['like-timeout']);
  });

  it('centring that times out skips the floor without an attempt', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2] });
    const surface: ActionSurface = {
      ...s.surface,
      centerLikeButton: async () => {
        throw timeoutError('locator.evaluate: Timeout 10000ms exceeded.');
      },
    };
    const { p, reports } = policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } });
    const a = act(time, surface, p);
    await a.run();
    expect(reports).toEqual([]);
    expect(a.warnings).toEqual(['like-timeout']);
  });

  it('opening the composer that times out posts nothing and discards whatever opened', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { openFails: timeoutError('locator.click: Timeout 10000ms exceeded.') });
    const { p, reports } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p);
    await a.run();
    expect(reports).toEqual([]);
    expect(a.warnings).toEqual(['reply-timeout']);
    expect(s.ops()).toEqual(['openComposer', 'discard']);
  });

  it('a submit press that times out is reported rejected and the draft discarded', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { submitFails: timeoutError('locator.click: Timeout 10000ms exceeded.') });
    const { p, reports } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p);
    await a.run();
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'rejected']);
    expect(a.warnings).toEqual(['reply-timeout']);
    expect(s.ops()).toEqual(['openComposer', 'fill', 'submit', 'discard']);
  });

  it('any other failure still ends the run', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2], pressFails: new Error('page crashed') });
    await expect(act(time, s.surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } }).p).run()).rejects.toThrow('page crashed');
  });
});

describe('LIKE-003 the kernel can turn liking off mid-topic (A09)', () => {
  it('asks liking() before every like and presses nothing once it answers false', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3, 4], confirms: () => false });
    let rejected = 0;
    const { p } = policy({ like: { enabled: true, replyRate: 100, topicRate: 100 }, liking: () => rejected < 2 });
    const reports: ActionReport[] = [];
    const counting: ActionPolicy = { ...p, onAction: (r) => (reports.push(r), r.result === 'rejected' && rejected++) };
    await act(time, s.surface, counting).run();
    expect(s.clicks()).toEqual([2, 3]);
    expect(tally(reports, 'reply')).toEqual({ attempted: 2, confirmed: 0 });
    expect(s.calls.some((c) => c.op === 'scrollToFirstPost')).toBe(false);
  });
});

describe('REPLY-001 the composer is typed into with fill, on either editor (A06)', () => {
  it.each<EditorKind>(['textarea', 'd-editor-input', 'prosemirror'])('fills the %s editor the composer opened with', async (editor) => {
    const time = new VirtualTime();
    const s = scripted(time, { editor });
    const { p, reports } = policy({ reply: REPLY_ON });
    await act(time, s.surface, p, { templates: ['写得很清楚，收藏慢慢看'] }).run();
    expect(s.calls.find((c) => c.op === 'fill')!.arg).toEqual({ kind: editor, text: '写得很清楚，收藏慢慢看' });
    expect(tally(reports, 'reply-post')).toEqual({ attempted: 1, confirmed: 1 });
  });

  it.each([
    ['linuxdo', 'textarea'],
    ['docofcard', 'prosemirror'],
  ] as const)('detects the %s composer as %s from the fixture, ProseMirror first', async (site, kind) => {
    const page = new StaticPage('https://x/t/y/1', fixture(site, 'reply-editor.html'));
    const opened: string[] = [];
    const time = new VirtualTime();
    const surface = pageSurface(page, time, { ...NO_COMPOSER, open: async () => void opened.push('open') });
    await expect(time.drive(surface.openComposer(new AbortController().signal))).resolves.toBe(kind);
    expect(opened).toEqual(['open']);
  });

  it('opens no composer when it did not appear, and posts nothing', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { editor: null });
    const { p, reports } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p);
    await a.run();
    expect(reports).toEqual([]);
    expect(a.warnings).toContain('composer-missing');
  });

  it('skips the reply and warns when the topic shows no reply button, never scrolling for it', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://linux.do/t/x/2496114/40', fixture('linuxdo', 'topic-wide.html'));
    const pressed: string[] = [];
    const surface = pageSurface(page, time, { ...NO_COMPOSER, open: async () => void pressed.push('open') });
    let wheels = 0;
    page.onWheel = () => void wheels++;
    const { p, reports } = policy({ reply: REPLY_ON });
    const a = act(time, surface, p);
    await a.run();
    expect(a.warnings).toEqual(['reply-button-missing']);
    expect(pressed).toEqual([]);
    expect(wheels).toBe(0);
    expect(reports).toEqual([]);
  });

  it('leaves a composer that is already open or minimised alone and posts nothing', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { composerBusy: true });
    const { p, reports } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p);
    await a.run();
    expect(a.warnings).toEqual(['composer-busy']);
    expect(s.ops()).toEqual([]);
    expect(reports).toEqual([]);
  });

  it.each(['open', 'draft'])('counts a composer with class %s as holding a draft, and a closed one as empty', async (cls) => {
    await expect(pageSurface(new StaticPage('https://x/t/y/1', `<div id="reply-control" class="${cls}"></div>`)).composerOpen()).resolves.toBe(true);
    await expect(pageSurface(new StaticPage('https://x/t/y/1', '<div id="reply-control" class="closed"></div>')).composerOpen()).resolves.toBe(false);
  });

  it('uses each template at most once per run', () => {
    const next = templatePicker(['一二三四五六', '七八九十一二'], seededRandom(9));
    expect([next(), next()].sort()).toEqual(['一二三四五六', '七八九十一二']);
    expect(next()).toBeNull();
  });
});

describe('REPLY-002 a discarded draft is checked closed (A07)', () => {
  it('polls until the composer is neither open nor draft', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://x/t/y/1', '<div id="reply-control" class="open"></div>');
    let discards = 0;
    const surface = pageSurface(page, time, {
      ...NO_COMPOSER,
      discard: async () => {
        discards++;
        page.html = '<div id="reply-control" class="draft"></div>';
        time.at(time.clock.monotonic() + 1_000, () => (page.html = '<div id="reply-control" class="closed"></div>'));
      },
    });
    await expect(time.drive(surface.discardComposer(new AbortController().signal))).resolves.toBe(true);
    expect(discards).toBe(1);
    expect(time.clock.monotonic()).toBeGreaterThanOrEqual(1_000);
  });

  it('answers false once 3 s pass with the composer still open', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://x/t/y/1', '<div id="reply-control" class="open"></div>');
    await expect(time.drive(pageSurface(page, time).discardComposer(new AbortController().signal))).resolves.toBe(false);
    expect(time.clock.monotonic()).toBe(DISCARD.verifyMs);
  });

  it('a draft that stays open warns composer-stuck and turns replies off for the rest of the run', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { closesOnSubmit: false, discardCloses: false });
    const { p, state } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p, { templates: ['一二三四五六', '七八九十一二'] });
    await a.run();
    expect(a.warnings).toEqual(['composer-stuck']);
    expect(state.replying).toBe(false);
    // The next topic's reply is never tried.
    const again = scripted(time);
    await act(time, again.surface, p).run();
    expect(again.ops()).toEqual([]);
  });
});

describe('STOP-002 no interaction after a stop (A08)', () => {
  it('a stop before acting presses nothing: every input checks the signal on entry', async () => {
    const time = new VirtualTime();
    const page = new StaticPage(
      'https://linux.do/t/x/1',
      `<div class="topic-post" data-post-number="2"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-unliked"></svg></button></div>`,
    );
    const pressed: string[] = [];
    const composer: Composer = {
      ...NO_COMPOSER,
      open: async () => void pressed.push('open'),
      fill: async () => void pressed.push('fill'),
      submit: async () => void pressed.push('submit'),
    };
    const surface = pageSurface(page, time, composer, async (n) => void pressed.push(`like ${n}`));
    const controller = new AbortController();
    controller.abort();
    const { p } = policy({ like: { enabled: true, replyRate: 100, topicRate: 100 }, reply: REPLY_ON });
    await expect(act(time, surface, p, { signal: controller.signal }).run()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surface.openComposer(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surface.fill('textarea', 'x', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surface.centerLikeButton(2, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pressed).toEqual([]);
  });

  it('a stop after typing discards the draft and never submits', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const controller = new AbortController();
    const run = act(time, s.surface, policy({ reply: REPLY_ON }).p, { signal: controller.signal }).run();
    // The editor settles for 0.5–1 s, then the 0.8–1.5 s pause after typing begins.
    time.at(1_200, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.ops()).toContain('discard');
    expect(s.ops()).not.toContain('submit');
  });

  it('a stop during a like press lets the press finish and still reads its result once', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2], pressMs: 2_000 });
    const controller = new AbortController();
    const { p, reports } = policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } });
    const run = act(time, s.surface, p, { signal: controller.signal }).run();
    time.at(1_000, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.ops()).toEqual(['center', 'clickLike', 'pressed']);
    expect(reports.map((r) => r.result)).toEqual(['attempted', 'confirmed']);
  });

  it('a stop during the reply confirmation still discards the unconfirmed draft (S05)', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { closesOnSubmit: false, acknowledged: false });
    const controller = new AbortController();
    const run = act(time, s.surface, policy({ reply: REPLY_ON }).p, { signal: controller.signal }).run();
    time.at(4_000, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.ops()).toEqual(['openComposer', 'fill', 'submit', 'discard']);
    expect(time.clock.monotonic() - 4_000).toBeLessThanOrEqual(DISCARD.afterStopMs);
  });

  it('a discard after a stop gives up within 2 s and reports the stuck composer', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { discardMs: 60_000 });
    const controller = new AbortController();
    const { p, state } = policy({ reply: REPLY_ON });
    const a = act(time, s.surface, p, { signal: controller.signal });
    const run = a.run();
    time.at(1_200, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(time.clock.monotonic()).toBe(1_200 + DISCARD.afterStopMs);
    expect(a.warnings).toEqual(['composer-stuck']);
    expect(state.replying).toBe(false);
  });
});

describe('Appendix B interaction pacing', () => {
  it('rests 0.8–1.5 s after a like, plus the extra wait when it is on', async () => {
    for (const extraWait of [false, true]) {
      const time = new VirtualTime();
      const s = scripted(time, { viewport: [2, 3] });
      await act(time, s.surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 0 }, extraWait }).p).run();
      const clicks = s.calls.filter((c) => c.op === 'clickLike');
      const gap = clicks[1]!.at - clicks[0]!.at;
      if (extraWait) {
        expect(gap).toBeGreaterThanOrEqual(800 + 1000);
        expect(gap).toBeLessThanOrEqual(1500 + 3000);
      } else {
        expect(gap).toBeGreaterThanOrEqual(800);
        expect(gap).toBeLessThanOrEqual(1500);
      }
    }
  });

  it('waits the extra wait before a reply, 0.5–1 s for the editor, 0.8–1.5 s before submitting and 1–2 s after', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const start = time.clock.monotonic();
    await act(time, s.surface, policy({ reply: REPLY_ON, extraWait: true }).p).run();
    const at = (op: string) => s.calls.find((c) => c.op === op)!.at;
    expect(at('openComposer') - start).toBeGreaterThanOrEqual(1000);
    expect(at('openComposer') - start).toBeLessThanOrEqual(3000);
    expect(at('fill') - at('openComposer')).toBeGreaterThanOrEqual(500);
    expect(at('fill') - at('openComposer')).toBeLessThanOrEqual(1000);
    expect(at('submit') - at('fill')).toBeGreaterThanOrEqual(800);
    expect(at('submit') - at('fill')).toBeLessThanOrEqual(1500);
    expect(time.clock.monotonic() - at('submit')).toBeGreaterThanOrEqual(1000);
    expect(time.clock.monotonic() - at('submit')).toBeLessThanOrEqual(2000);
  });
});
