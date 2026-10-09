import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunError, stopRequestOf } from '@disco-lurk/core';
import type { Page } from 'playwright-core';
import { PAGE_TIMEOUTS, PageView, TargetWatch } from './page';

const targetClosedError = () => Object.assign(new Error('page.content: Target page, context or browser has been closed'), { name: 'TargetClosedError' });
const failing = () => Promise.reject(targetClosedError());

describe('TargetWatch: a closed window is a stop, a crashed renderer is a failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a page that crashed turns TargetClosedError into internal "page crashed" and never aborts the session', async () => {
    const watch = new TargetWatch();
    watch.markCrashed();
    await expect(watch.call(failing)).rejects.toEqual(new RunError('internal', 'page crashed'));
    expect(watch.closed.signal.aborted).toBe(false);
  });

  it('a closed page or context turns it into the browser-closed stop request', async () => {
    const watch = new TargetWatch();
    watch.markClosed();
    await expect(watch.call(failing)).rejects.toMatchObject({ name: 'AbortError' });
    expect(stopRequestOf(watch.closed.signal)).toBe('browser-closed');
  });

  it('waits for the event when the call is rejected before it arrives', async () => {
    const watch = new TargetWatch();
    const result = watch.call(failing);
    const settled = expect(result).rejects.toEqual(new RunError('internal', 'page crashed'));
    await vi.advanceTimersByTimeAsync(100);
    watch.markCrashed();
    await settled;
    expect(watch.closed.signal.aborted).toBe(false);
  });

  it('a crash followed by the session closing the browser stays a crash', async () => {
    const watch = new TargetWatch();
    watch.markCrashed();
    watch.markClosed();
    await expect(watch.call(failing)).rejects.toBeInstanceOf(RunError);
    expect(watch.closed.signal.aborted).toBe(false);
  });

  it('without either event the original error passes through', async () => {
    const watch = new TargetWatch();
    const settled = expect(watch.call(failing)).rejects.toMatchObject({ name: 'TargetClosedError' });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUTS.goneEventMs);
    await settled;
  });

  it('leaves every other error alone', async () => {
    const watch = new TargetWatch();
    watch.markClosed();
    await expect(watch.call(() => Promise.reject(new Error('net::ERR_FAILED')))).rejects.toThrow('net::ERR_FAILED');
  });
});

describe('PageView reads visibility when asked, injecting nothing into the page', () => {
  it('evaluates document.visibilityState on every read and installs no binding or init script', async () => {
    let state: DocumentVisibilityState = 'hidden';
    const calls: string[] = [];
    const fake = {
      exposeBinding: async () => void calls.push('exposeBinding'),
      addInitScript: async () => void calls.push('addInitScript'),
      evaluate: async () => {
        calls.push('evaluate');
        return state;
      },
    };
    const view = new PageView(fake as unknown as Page);
    await expect(view.visibilityState()).resolves.toBe('hidden');
    state = 'visible';
    await expect(view.visibilityState()).resolves.toBe('visible');
    expect(calls).toEqual(['evaluate', 'evaluate']);
  });
});
