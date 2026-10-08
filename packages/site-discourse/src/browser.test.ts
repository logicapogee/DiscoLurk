import { describe, expect, it } from 'vitest';
import { launchOptions } from './browser';

describe('launch options', () => {
  it.each([true, false])('leave SIGINT, SIGTERM and SIGHUP to the CLI (headless %s)', (headless) => {
    const opts = launchOptions({ channel: 'chrome', headless });
    expect(opts).toMatchObject({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  });
});
