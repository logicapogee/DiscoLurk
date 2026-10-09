import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Category } from '@disco-lurk/core';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScheduleFromArgs, formatSchedules, listSchedules, splitAddArgs } from './schedule';
import { findSite } from './sites';

const known = (siteId: string): Category[] => findSite(siteId)?.builtinCategories ?? [];
const fixedId = () => 'abc123';

describe('lurk schedule add arguments', () => {
  it('separates schedule options from the preset options lurk run takes', () => {
    expect(splitAddArgs(['--name', 'n', '--cron=0 7 * * *', '--browse-mode', 'quick', '--run-on-start', '--like'])).toEqual({
      flags: { name: 'n', cron: '0 7 * * *', 'run-on-start': true },
      runArgv: ['--browse-mode', 'quick', '--like'],
    });
  });

  it('builds a headless daily-window schedule with a topic target by default', () => {
    const { spec, preset } = buildScheduleFromArgs(['--name', 'day', '--runs', '2', '--window', '07:00-23:00', '--timezone', 'Asia/Shanghai'], known, fixedId);
    expect(spec).toEqual({
      id: 'abc123',
      name: 'day',
      profileId: `${process.env.LURK_SITE ?? 'linuxdo'}/default`,
      presetId: 'abc123',
      enabled: true,
      browserMode: 'headless',
      timezone: 'Asia/Shanghai',
      trigger: { kind: 'daily-window', runs: 2, start: '07:00', end: '23:00', jitterMinutes: 15, minGapMinutes: 60 },
      misfire: { policy: 'skip', graceMinutes: 30 },
      overlap: 'skip',
      unavailableDisplay: 'skip',
      runOnStart: false,
    });
    expect(preset.runMode).toEqual({ kind: 'topics', min: 15, max: 40 });
    expect(preset.interaction.like.enabled).toBe(false);
  });

  it('takes cron, headed, misfire, display fallback and the preset options', () => {
    const { spec, preset } = buildScheduleFromArgs(
      [
        '--name', 'evening', '--id', 'eve', '--site', 'linuxdo', '--profile', 'main', '--cron', '30 20 * * 1-5', '--headed', '--fallback-headless',
        '--misfire', 'run-once', '--grace', '10', '--disabled', '--browse-mode', 'quick', '--run-mode', 'time:20', '--categories', 'develop', '--like', '--like-rate', '20',
      ],
      known,
      fixedId,
    );
    expect(spec).toMatchObject({
      id: 'eve',
      profileId: 'linuxdo/main',
      enabled: false,
      browserMode: 'headed',
      trigger: { kind: 'cron', expression: '30 20 * * 1-5' },
      misfire: { policy: 'run-once', graceMinutes: 10 },
      unavailableDisplay: 'fallback-headless',
    });
    expect(preset).toMatchObject({ id: 'eve', siteId: 'linuxdo', browseMode: 'quick', runMode: { kind: 'time', minutes: 20 }, categoryPaths: ['/c/develop/4'] });
    expect(preset.interaction.like).toMatchObject({ enabled: true, topicRate: 20 });
  });

  it.each([
    [['--runs', '2', '--window', '07:00-23:00'], /needs --name/],
    [['--name', 'x'], /needs --cron/],
    [['--name', 'x', '--cron', '0 7 * * *', '--runs', '2'], /--cron excludes/],
    [['--name', 'x', '--cron', '0 7 * * *', '--misfire', 'later'], /--misfire must be skip or run-once/],
    [['--name', 'x', '--cron', '0 7 * * *', '--json'], /--json does not apply/],
    [['--name', 'x', '--cron', '0 7 * * *', '--reply'], /i-understand-auto-reply-risk/],
    [['--name', 'x', '--id', 'bad id', '--cron', '0 7 * * *'], /Invalid --id/],
  ])('rejects %j', (argv, message) => {
    expect(() => buildScheduleFromArgs(argv, known, fixedId)).toThrow(message);
  });
});

describe('lurk schedule list', () => {
  it('shows the materialized next run, status and recent history', () => {
    const { spec, preset } = buildScheduleFromArgs(['--name', 'day', '--cron', '0 8 * * *', '--timezone', 'UTC', '--site', 'linuxdo'], known, fixedId);
    const snapshot = {
      id: 'p1',
      scheduleId: spec.id,
      siteId: 'linuxdo',
      profileId: spec.profileId,
      browserMode: 'headless' as const,
      preset: { ...preset, presetId: preset.id, runMode: { kind: 'topics' as const, count: 23 }, categories: known('linuxdo').slice(0, 2) },
      seed: 1,
      plannedAt: '2026-10-09T08:00:00.000Z',
      materializedAt: '2026-10-08T08:00:00.000Z',
    };
    const items = listSchedules(
      { schedules: [spec], presets: [preset] },
      {
        schemaVersion: 1,
        schedules: {
          [spec.id]: {
            paused: true,
            runOnStartConsumed: false,
            generatedDays: [],
            planned: [{ snapshot, status: 'pending' }],
            history: [{ at: '2026-10-08T08:00:00.000Z', snapshotId: 'p0', cause: 'planned', outcome: 'started', runId: 'r', ended: { at: '2026-10-08T08:20:00.000Z', outcome: 'completed', stopCause: 'target' } }],
          },
        },
      },
      Date.parse('2026-10-08T12:00:00Z'),
    );
    expect(items[0]!.next!.id).toBe('p1');
    const text = formatSchedules(items);
    expect(text).toContain('abc123  day  [paused]');
    expect(text).toContain('next 2026-10-09 08:00 · deep · 23 topics · 2 categories');
    expect(text).toContain('2026-10-08 08:00 planned started → completed (target)');
  });
});

describe('the lurk binary: schedule commands', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const bundle = join(root, 'packages/cli/dist', `schedule-test-${process.pid}.cjs`);
  const home = mkdtempSync(join(tmpdir(), 'lurk-sched-home-'));

  beforeAll(async () => {
    await build({
      entryPoints: [join(root, 'packages/cli/src/main.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['bufferutil', 'utf-8-validate', 'chromium-bidi/*', 'playwright-core'],
      logLevel: 'silent',
    });
  }, 60_000);
  afterAll(() => rmSync(bundle, { force: true }));

  const lurk = (...args: string[]) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LURK_')));
    const r = spawnSync(process.execPath, [bundle, 'schedule', ...args], {
      env: { ...env, HOME: home, XDG_DATA_HOME: join(home, 'data'), APPDATA: join(home, 'appdata') },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('adds, lists, pauses, resumes and removes a schedule', () => {
    expect(lurk('add', '--name', 'morning', '--id', 'am', '--site', 'linuxdo', '--cron', '0 8 * * *', '--timezone', 'UTC')).toMatchObject({ code: 0 });
    expect(lurk('add', '--name', 'again', '--id', 'am', '--cron', '0 9 * * *')).toMatchObject({ code: 4, err: expect.stringMatching(/already exists/) });
    expect(lurk('list').out).toContain('am  morning  [active]  linuxdo/default · headless · cron "0 8 * * *" UTC');
    expect(lurk('pause', 'am')).toMatchObject({ code: 0 });
    expect(lurk('list').out).toContain('[paused]');
    expect(lurk('resume', 'am')).toMatchObject({ code: 0 });
    expect(lurk('list').out).toContain('[active]');
    const listed = JSON.parse(lurk('list', '--json').out);
    expect(listed[0].spec.id).toBe('am');
    expect(lurk('pause', 'nope')).toMatchObject({ code: 4, err: expect.stringMatching(/No schedule nope/) });
    expect(lurk('remove', 'am')).toMatchObject({ code: 0 });
    expect(lurk('list').out).toContain('No schedules');
    expect(lurk('frobnicate')).toMatchObject({ code: 4 });
  }, 30_000);
});
