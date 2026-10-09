import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyLog, localDay } from './log-file';

describe('sidecar daily log', () => {
  it('writes one file per local day and keeps seven days', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'lurk-log-')), 'logs');
    let now = new Date(2026, 9, 1, 12, 0, 0);
    const log = new DailyLog(dir, () => now);
    log.write('first');
    for (let d = 2; d <= 9; d++) {
      now = new Date(2026, 9, d, 8, 0, 0);
      log.write(`day ${d}`);
    }
    const names = readdirSync(dir).sort();
    expect(names[0]).toBe('sidecar-2026-10-03.log');
    expect(names).toHaveLength(7);
    expect(readFileSync(join(dir, `sidecar-${localDay(now)}.log`), 'utf8')).toMatch(/Z day 9\n$/);
  });

  it('leaves files that are not its own alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lurk-log-'));
    writeFileSync(join(dir, 'sidecar.log'), 'legacy');
    writeFileSync(join(dir, 'sidecar-2000-01-01.log'), 'old');
    new DailyLog(dir, () => new Date(2026, 9, 9)).write('x');
    expect(existsSync(join(dir, 'sidecar.log'))).toBe(true);
    expect(existsSync(join(dir, 'sidecar-2000-01-01.log'))).toBe(false);
  });
});
