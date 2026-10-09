import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { VirtualTime } from '@disco-lurk/core/testing';
import { acknowledgedPost, loginForm, watchSiteRequests } from './session';

describe('B10 login form', () => {
  it('a stop request ends a submit whose page call hangs, without waiting for its timeout', async () => {
    const time = new VirtualTime();
    const hanging = { locator: () => ({ fill: () => new Promise<void>(() => {}), click: async () => {} }) } as unknown as Pick<Page, 'locator'>;
    const form = loginForm(hanging, time.deps(), (fn) => fn());
    const stop = new AbortController();
    time.at(1_000, () => stop.abort());
    await expect(time.drive(form.submit({ username: 'u', password: 'p' }, stop.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(time.clock.monotonic()).toBe(1_000);
  });

  it('names a timed-out step page-timeout, by step and error class only', async () => {
    const time = new VirtualTime();
    const slow = {
      locator: () => ({
        fill: async () => {},
        click: async () => {
          throw Object.assign(new Error('locator.click: Timeout 10000ms exceeded.'), { name: 'TimeoutError' });
        },
      }),
    } as unknown as Pick<Page, 'locator'>;
    const form = loginForm(slow, time.deps(), (fn) => fn());
    await expect(time.drive(form.submit({ username: 'u', password: 'p' }, new AbortController().signal))).rejects.toMatchObject({
      code: 'page-timeout',
      message: 'submit failed: TimeoutError',
    });
  });
});

type Finished = Parameters<typeof acknowledgedPost>[1];

function finished(url: string, opts: { method?: string; status?: number; body?: string; response?: () => Promise<unknown> } = {}): Finished {
  const ok = (opts.status ?? 200) < 400;
  return {
    url: () => url,
    method: () => opts.method ?? 'POST',
    postData: () => opts.body ?? null,
    response: (opts.response ?? (async () => ({ ok: () => ok }))) as Finished['response'],
  };
}

/** A page that only hands out its `requestfinished` listener. */
function listeningPage() {
  let listener: ((request: Finished) => void) | undefined;
  const page = { on: (_event: string, fn: (request: Finished) => void) => void (listener = fn) } as unknown as Pick<Page, 'on'>;
  return { page, finish: (request: Finished) => listener!(request) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('A07 a reply is acknowledged by the site, read from finished requests', () => {
  it('accepts only a successful POST to the site’s own /posts', async () => {
    const posts = 'https://linux.do/posts';
    await expect(acknowledgedPost(posts, finished('https://linux.do/posts'))).resolves.toBe(true);
    await expect(acknowledgedPost(posts, finished('https://linux.do/posts?x=1'))).resolves.toBe(true);
    await expect(acknowledgedPost(posts, finished('https://linux.do/posts', { status: 422 }))).resolves.toBe(false);
    await expect(acknowledgedPost(posts, finished('https://linux.do/posts', { method: 'GET' }))).resolves.toBe(false);
    await expect(acknowledgedPost(posts, finished('https://linux.do/posts/123/bookmark'))).resolves.toBe(false);
    await expect(acknowledgedPost(posts, finished('https://other.invalid/posts'))).resolves.toBe(false);
  });

  it('counts acknowledged posts and delivers read receipts from the same listener', async () => {
    const { page, finish } = listeningPage();
    const receipts: unknown[] = [];
    const watch = watchSiteRequests(page, { baseUrl: 'https://linux.do' }, { onTimings: (r) => receipts.push(r), warn: () => {} });
    finish(finished('https://linux.do/posts'));
    finish(finished('https://linux.do/posts', { status: 422 }));
    finish(finished('https://linux.do/topics/timings', { body: 'timings%5B1%5D=1000&topic_time=1000&topic_id=7' }));
    await settle();
    expect(watch.postsAcknowledged()).toBe(1);
    expect(receipts).toEqual([{ topicId: '7', postNumbers: [1], topicMs: 1000 }]);
  });

  it('a response that cannot be read warns, except when the page has closed', async () => {
    const { page, finish } = listeningPage();
    const warnings: string[] = [];
    watchSiteRequests(page, { baseUrl: 'https://linux.do' }, { warn: (code) => warnings.push(code) });
    const failing = (err: Error) => finished('https://linux.do/posts', { response: () => Promise.reject(err) });
    finish(failing(Object.assign(new Error('Target page, context or browser has been closed'), { name: 'TargetClosedError' })));
    await settle();
    expect(warnings).toEqual([]);
    finish(failing(new Error('Protocol error')));
    await settle();
    expect(warnings).toEqual(['request-unreadable']);
  });
});
