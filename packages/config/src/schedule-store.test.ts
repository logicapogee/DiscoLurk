import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSchedulerContract, preset, spec } from '@disco-lurk/scheduler/contract';
import { describe, expect, it } from 'vitest';
import { acquireSchedulerLock, ConfigFileError, FileScheduleBook, FileScheduleStore, SchedulerLockedError } from './schedule-store';

const tmp = () => mkdtempSync(join(tmpdir(), 'lurk-sched-'));

describeSchedulerContract('FileScheduleStore', () => {
  const dir = tmp();
  return () => new FileScheduleStore(dir);
});

describe('FileScheduleStore', () => {
  it('reports a missing file as no state and leaves no temp files behind', async () => {
    const dir = tmp();
    const store = new FileScheduleStore(dir);
    expect(await store.load()).toBeNull();
    await Promise.all([store.save({ schemaVersion: 1, schedules: {} }), store.save({ schemaVersion: 1, schedules: {} })]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('names the file when it is not JSON', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), '{"schemaVersion":1,');
    const err = await new FileScheduleStore(dir).load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigFileError);
    expect((err as Error).message).toContain(join(dir, 'state.json'));
    expect((err as Error).message).toMatch(/not valid JSON/);
  });

  it('names the file and the field when the content does not match', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, schedules: { s1: { paused: 'yes' } } }));
    await expect(new FileScheduleStore(dir).load()).rejects.toThrow(/state\.json: not a valid scheduler state file \(schedules\.s1\.paused/);
  });
});

describe('FileScheduleBook', () => {
  const book = () => ({ schedules: [spec({ profileId: 'linuxdo/default' })], presets: [preset(15, 40)] });

  it('round-trips definitions and starts empty without a file', async () => {
    const b = new FileScheduleBook(tmp());
    expect(await b.load()).toEqual({ schedules: [], presets: [] });
    await b.save(book());
    expect(await b.load()).toEqual(book());
    expect(JSON.parse(readFileSync(b.path, 'utf8')).schemaVersion).toBe(1);
  });

  it.each([
    ['a duplicate schedule id', (x: ReturnType<typeof book>) => x.schedules.push(x.schedules[0]!), /schedule id s1 is used twice/],
    ['a missing preset', (x: ReturnType<typeof book>) => (x.presets = []), /names preset default, which does not exist/],
    ['a preset of another site', (x: ReturnType<typeof book>) => (x.schedules[0]!.profileId = 'docofcard/main'), /of site linuxdo/],
    ['an invalid cron expression', (x: ReturnType<typeof book>) => (x.schedules[0]!.trigger = { kind: 'cron', expression: '* * *' }), /schedule s1: Invalid cron/],
    ['an unknown time zone', (x: ReturnType<typeof book>) => (x.schedules[0]!.timezone = 'Mars/Base'), /Unknown time zone "Mars\/Base"/],
  ])('refuses to save %s', async (_name, mutate, message) => {
    const b = new FileScheduleBook(tmp());
    const x = book();
    mutate(x);
    await expect(b.save(x)).rejects.toThrow(message);
  });

  it('names the file when a hand edit breaks it', async () => {
    const b = new FileScheduleBook(tmp());
    await b.save(book());
    const raw = JSON.parse(readFileSync(b.path, 'utf8'));
    raw.schedules[0].misfire.policy = 'later';
    writeFileSync(b.path, JSON.stringify(raw));
    await expect(b.load()).rejects.toThrow(new RegExp(`${b.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not a valid schedule file \\(schedules\\.0\\.misfire\\.policy`));
  });
});

describe('acquireSchedulerLock', () => {
  it('lets one owner in at a time and takes over a dead owner', async () => {
    const dir = tmp();
    const lock = await acquireSchedulerLock(dir);
    await expect(acquireSchedulerLock(dir)).rejects.toBeInstanceOf(SchedulerLockedError);
    await lock.release();
    const again = await acquireSchedulerLock(dir);
    await again.release();
    writeFileSync(join(dir, '.lurk-lock'), JSON.stringify({ pid: 999_999, startedAt: 'x' }));
    const takeover = await acquireSchedulerLock(dir, { isAlive: (pid) => pid !== 999_999 });
    await takeover.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('takes over a lock naming this PID that this process does not hold, as after a container restart', async () => {
    const dir = tmp();
    writeFileSync(join(dir, '.lurk-lock'), JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    const lock = await acquireSchedulerLock(dir);
    await expect(acquireSchedulerLock(dir)).rejects.toBeInstanceOf(SchedulerLockedError);
    await lock.release();
  });

  it('takes over a lock from another host or from a recycled PID', async () => {
    const dir = tmp();
    const live = { isAlive: () => true, startTime: async () => 1_000_000 };
    writeFileSync(join(dir, '.lurk-lock'), JSON.stringify({ pid: 4242, hostname: 'elsewhere', processStartedAt: 1_000_000 }));
    await (await acquireSchedulerLock(dir, live)).release();
    writeFileSync(join(dir, '.lurk-lock'), JSON.stringify({ pid: 4242, hostname: hostname(), processStartedAt: 2_000_000 }));
    await (await acquireSchedulerLock(dir, live)).release();
    writeFileSync(join(dir, '.lurk-lock'), JSON.stringify({ pid: 4242, hostname: hostname(), processStartedAt: 1_002_000 }));
    await expect(acquireSchedulerLock(dir, live)).rejects.toMatchObject({ pid: 4242 });
  });

  it('records the host and the start time of the owning process', async () => {
    const dir = tmp();
    const lock = await acquireSchedulerLock(dir);
    const info = JSON.parse(readFileSync(join(dir, '.lurk-lock'), 'utf8')) as { pid: number; hostname: string; processStartedAt: number };
    expect(info).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(Math.abs(info.processStartedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
    await lock.release();
  });
});
