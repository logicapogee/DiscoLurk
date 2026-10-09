import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seededRandom, type ActionPolicy, type ActionReport, type InteractionPolicy } from '@disco-lurk/core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { FIRST_POST, PageActionSurface, performActions, templatePicker, type ActionSurface, type Composer } from './actions';
import type { EditorKind } from './parse';
import { likeButtonOf } from './selectors';
import { StaticPage } from './testing';

const OFF: InteractionPolicy = { like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5 } };

/** A policy whose liking switch is the preset's; `liking` overrides it, as the kernel's like limit would. */
function policy(over: { like?: Partial<InteractionPolicy['like']>; reply?: Partial<InteractionPolicy['reply']>; extraWait?: boolean; liking?: () => boolean } = {}) {
  const reports: ActionReport[] = [];
  const like = { ...OFF.like, ...over.like };
  const p: ActionPolicy = {
    like,
    reply: { ...OFF.reply, ...over.reply },
    extraWait: { enabled: over.extraWait ?? false, minSec: 1, maxSec: 3 },
    liking: over.liking ?? (() => like.enabled),
    onAction: (r) => reports.push(r),
  };
  return { p, reports };
}

/** Attempted and confirmed counts per bucket, as the kernel would add them up. */
function tally(reports: readonly ActionReport[], bucket: ActionReport['bucket']) {
  const of = (result: ActionReport['result']) => reports.filter((r) => r.bucket === bucket && r.result === result).length;
  return { attempted: of('attempted'), confirmed: of('confirmed') };
}

interface Script {
  viewport?: number[];
  liked?: number[];
  /** Floors whose like button exists; all floors by default. */
  buttons?: number[];
  /** Whether a click on this floor turns into the liked state. */
  confirms?: (post: number) => boolean;
  firstPostRenders?: boolean;
  editor?: EditorKind | null;
  posted?: boolean;
}

/** Records every call with the virtual time it happened at. */
function scripted(time: VirtualTime, s: Script = {}) {
  const calls: Array<{ op: string; arg?: unknown; at: number }> = [];
  const log = (op: string, arg?: unknown): void => void calls.push({ op, ...(arg !== undefined ? { arg } : {}), at: time.clock.monotonic() });
  const liked = new Set(s.liked ?? []);
  const surface: ActionSurface = {
    postsInViewport: async () => s.viewport ?? [],
    hasLikeButton: async (n) => s.buttons === undefined || s.buttons.includes(n),
    isLiked: async (n) => liked.has(n),
    scrollToFirstPost: async () => {
      log('scrollToFirstPost');
      return s.firstPostRenders ?? true;
    },
    like: async (n) => {
      log('clickLike', n);
      if (s.confirms?.(n) ?? true) liked.add(n);
    },
    openComposer: async () => {
      log('openComposer');
      return s.editor === undefined ? 'textarea' : s.editor;
    },
    // Typing, the pause after it and submitting, with the pause cut short by a stop like the real one.
    compose: async (kind, text, signal) => {
      log('fill', { kind, text });
      await time.sleeper.sleep(1_000, signal);
      log('submit');
    },
    composerOpen: async () => !(s.posted ?? true),
    discardComposer: async () => log('discard'),
  };
  return { surface, calls, clicks: () => calls.filter((c) => c.op === 'clickLike').map((c) => c.arg) };
}

function act(time: VirtualTime, surface: ActionSurface, p: ActionPolicy, opts: { templates?: string[]; signal?: AbortSignal; seed?: number } = {}) {
  const warnings: string[] = [];
  const deps = { ...time.deps(), random: seededRandom(opts.seed ?? 1) };
  const ctx = { nextTemplate: templatePicker(opts.templates ?? ['感谢分享，学到了新东西'], deps.random), warn: (c: string) => warnings.push(c) };
  return { run: () => time.drive(performActions(surface, p, deps, ctx, opts.signal ?? new AbortController().signal)), warnings };
}

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

describe('LIKE-001 a liked floor is never pressed again (A03)', () => {
  it('skips liked floors and floors without a like button', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { viewport: [2, 3, 4], liked: [2], buttons: [1, 2, 4] });
    await act(time, s.surface, policy({ like: { enabled: true, replyRate: 100, topicRate: 0 } }).p).run();
    expect(s.clicks()).toEqual([4]);
  });

  const page = (post: string) =>
    new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2">${post}<button class="btn-toggle-reaction-like"></button></div>`);
  const surface = (p: StaticPage) => new PageActionSurface(p, { click: async () => {} }, NO_COMPOSER, new VirtualTime().deps(), () => {});

  it.each([
    ['reactions container only', '<div class="discourse-reactions-actions has-reacted has-used-main-reaction"></div>', true],
    ['liked icon only', '<button class="btn-toggle-reaction-like"><svg class="d-icon-d-liked"></svg></button>', true],
    ['both markers', '<div class="discourse-reactions-actions has-reacted"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-liked"></svg></button></div>', true],
    ['unliked icon', '<div class="discourse-reactions-actions"><button class="btn-toggle-reaction-like"><svg class="d-icon-d-unliked"></svg></button></div>', false],
    ['retired has-used marker only', '<div class="has-used has-like my-likes"></div>', false],
  ])('%s → liked %s', async (_name, html, expected) => {
    await expect(surface(page(html)).isLiked(2)).resolves.toBe(expected);
  });

  it.each(['linuxdo', 'docofcard'])('reads the hand-liked floor of the %s fixture as liked and floor 1 as not', async (site) => {
    const html = readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/${site}/liked.html`, import.meta.url)), 'utf8');
    const s = surface(new StaticPage('https://x/t/y/1', html));
    await expect(s.isLiked(2)).resolves.toBe(true);
    await expect(s.isLiked(1)).resolves.toBe(false);
  });
});

const NO_COMPOSER: Composer = { open: async () => {}, fill: async () => {}, submit: async () => {}, discard: async () => {} };

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
    const read = (site: string, file: string) => readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/${site}/${file}`, import.meta.url)), 'utf8');
    const page = new StaticPage('https://linux.do/t/x/2496114/40', read('linuxdo', 'topic-wide.html'));
    let wheels = 0;
    page.onWheel = (dy) => {
      expect(dy).toBe(FIRST_POST.stepPx);
      if (++wheels === 3) page.html = read('linuxdo', 'liked.html');
    };
    const pressed: number[] = [];
    const time = new VirtualTime();
    const surface = new PageActionSurface(page, { click: async (n) => void pressed.push(n) }, NO_COMPOSER, time.deps(), () => {});
    await expect(time.drive(surface.scrollToFirstPost(new AbortController().signal))).resolves.toBe(true);
    expect(wheels).toBe(3);
    await time.drive(surface.like(1, new AbortController().signal));
    expect(pressed).toEqual([1]);
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
  it('centres the button, waits about 300 ms, then clicks', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2"><button class="btn-toggle-reaction-like"></button></div>`);
    const marks: Array<{ op: string; at: number }> = [];
    page.scrollIntoView = async () => void marks.push({ op: 'center', at: time.clock.monotonic() });
    const surface = new PageActionSurface(page, { click: async () => void marks.push({ op: 'click', at: time.clock.monotonic() }) }, NO_COMPOSER, time.deps(), () => {});
    await time.drive(surface.like(2, new AbortController().signal));
    expect(marks.map((m) => m.op)).toEqual(['center', 'click']);
    expect(marks[1]!.at - marks[0]!.at).toBe(300);
  });

  it('reports a confirmed like as attempted then confirmed, in the topic bucket for floor 1', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const { p, reports } = policy({ like: { enabled: true, topicRate: 100 } });
    await act(time, s.surface, p).run();
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
    expect(time.clock.monotonic()).toBeGreaterThanOrEqual(5_000);
  });

  it('a reply whose composer stays open is attempted, rejected and discarded', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { posted: false });
    const { p, reports } = policy({ reply: { enabled: true, rate: 100 } });
    await act(time, s.surface, p).run();
    expect(reports).toEqual([
      { action: 'reply', bucket: 'reply-post', result: 'attempted' },
      { action: 'reply', bucket: 'reply-post', result: 'rejected' },
    ]);
    expect(s.calls.map((c) => c.op)).toEqual(['openComposer', 'fill', 'submit', 'discard']);
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
    const { p, reports } = policy({ reply: { enabled: true, rate: 100 } });
    await act(time, s.surface, p, { templates: ['写得很清楚，收藏慢慢看'] }).run();
    expect(s.calls.find((c) => c.op === 'fill')!.arg).toEqual({ kind: editor, text: '写得很清楚，收藏慢慢看' });
    expect(tally(reports, 'reply-post')).toEqual({ attempted: 1, confirmed: 1 });
  });

  it.each([
    ['linuxdo', 'textarea'],
    ['docofcard', 'd-editor-input'],
  ] as const)('detects the %s composer as %s from the fixture', async (site, kind) => {
    const html = readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/${site}/reply-editor.html`, import.meta.url)), 'utf8');
    const page = new StaticPage('https://x/t/y/1', html);
    const opened: string[] = [];
    const time = new VirtualTime();
    const surface = new PageActionSurface(page, { click: async () => {} }, { ...NO_COMPOSER, open: async () => void opened.push('open') }, time.deps(), () => {});
    await expect(time.drive(surface.openComposer(new AbortController().signal))).resolves.toBe(kind);
    expect(opened).toEqual(['open']);
  });

  it('opens no composer when it did not appear, and posts nothing', async () => {
    const time = new VirtualTime();
    const s = scripted(time, { editor: null });
    const { p, reports } = policy({ reply: { enabled: true, rate: 100 } });
    const a = act(time, s.surface, p);
    await a.run();
    expect(reports).toEqual([]);
    expect(a.warnings).toContain('composer-missing');
  });

  it('uses each template at most once per run', () => {
    const next = templatePicker(['一二三四五六', '七八九十一二'], seededRandom(9));
    expect([next(), next()].sort()).toEqual(['一二三四五六', '七八九十一二']);
    expect(next()).toBeNull();
  });
});

describe('STOP-002 no interaction after a stop (A08)', () => {
  it('a stop before acting presses nothing: every input checks the signal on entry', async () => {
    const time = new VirtualTime();
    const page = new StaticPage('https://linux.do/t/x/1', `<div class="topic-post" data-post-number="2"><button class="btn-toggle-reaction-like"></button></div>`);
    const pressed: string[] = [];
    const composer: Composer = {
      open: async () => void pressed.push('open'),
      fill: async () => void pressed.push('fill'),
      submit: async () => void pressed.push('submit'),
      discard: async () => {},
    };
    const surface = new PageActionSurface(page, { click: async (n) => void pressed.push(`like ${n}`) }, composer, time.deps(), () => {});
    const controller = new AbortController();
    controller.abort();
    const { p } = policy({ like: { enabled: true, replyRate: 100, topicRate: 100 }, reply: { enabled: true, rate: 100 } });
    await expect(act(time, surface, p, { signal: controller.signal }).run()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surface.openComposer(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surface.compose('textarea', 'x', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(pressed).toEqual([]);
  });

  it('a stop after typing discards the draft and never submits', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const controller = new AbortController();
    const a = act(time, s.surface, policy({ reply: { enabled: true, rate: 100 } }).p, { signal: controller.signal });
    const run = a.run();
    // The editor settles for 0.5–1 s, then the 0.8–1.5 s pause after typing begins.
    time.at(1_200, () => controller.abort());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const ops = s.calls.map((c) => c.op);
    expect(ops).toContain('discard');
    expect(ops).not.toContain('submit');
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

  it('waits the extra wait before a reply, 0.5–1 s for the editor and 1–2 s after submitting', async () => {
    const time = new VirtualTime();
    const s = scripted(time);
    const start = time.clock.monotonic();
    await act(time, s.surface, policy({ reply: { enabled: true, rate: 100 }, extraWait: true }).p).run();
    const at = (op: string) => s.calls.find((c) => c.op === op)!.at;
    expect(at('openComposer') - start).toBeGreaterThanOrEqual(1000);
    expect(at('openComposer') - start).toBeLessThanOrEqual(3000);
    expect(at('fill') - at('openComposer')).toBeGreaterThanOrEqual(500);
    expect(at('fill') - at('openComposer')).toBeLessThanOrEqual(1000);
    expect(time.clock.monotonic() - at('submit')).toBeGreaterThanOrEqual(1000);
    expect(time.clock.monotonic() - at('submit')).toBeLessThanOrEqual(2000);
  });

  it('pauses 0.8–1.5 s between typing and submitting', async () => {
    const time = new VirtualTime();
    const marks: Array<{ op: string; at: number }> = [];
    const mark = (op: string) => async () => void marks.push({ op, at: time.clock.monotonic() });
    const page = new StaticPage('https://x/t/y/1', '');
    const surface = new PageActionSurface(page, { click: async () => {} }, { ...NO_COMPOSER, fill: mark('fill'), submit: mark('submit') }, time.deps(), () => {});
    await time.drive(surface.compose('textarea', '感谢分享', new AbortController().signal));
    const gap = marks[1]!.at - marks[0]!.at;
    expect(marks.map((m) => m.op)).toEqual(['fill', 'submit']);
    expect(gap).toBeGreaterThanOrEqual(800);
    expect(gap).toBeLessThanOrEqual(1500);
  });
});
