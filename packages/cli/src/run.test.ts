import { describe, expect, it } from 'vitest';
import type { Category } from '@disco-lurk/core';
import {
  buildPlan,
  credentialsFromEnv,
  EXIT,
  exitCodeFor,
  parseLoginArgs,
  parseProfileId,
  parseRunArgs,
  parseRunMode,
  resolveCategories,
  UsageError,
} from './run';
import { findSite } from './sites';

const linuxdo = findSite('linuxdo')!;
const docofcard = findSite('docofcard')!;

describe('CLI-001 lurk run arguments (§11.1)', () => {
  it('defaults to linuxdo, Profile default, deep, endless, headed Chrome, human output', () => {
    const args = parseRunArgs([]);
    expect(args).toMatchObject({
      profile: 'default',
      browseMode: 'deep',
      runMode: { kind: 'endless' },
      categories: null,
      browserMode: 'headed',
      channel: 'chrome',
      json: false,
    });
    expect(args.site.id).toBe(process.env.LURK_SITE ?? 'linuxdo');
  });

  it('reads every option', () => {
    const args = parseRunArgs([
      '--site', 'docofcard', '--profile', 'main', '--browse-mode', 'quick', '--run-mode', 'topics:5',
      '--categories', 'bank, /c/general/4', '--headless', '--channel', 'msedge', '--json',
    ]);
    expect(args).toMatchObject({
      profile: 'main',
      browseMode: 'quick',
      runMode: { kind: 'topics', min: 5, max: 5 },
      categories: ['bank', '/c/general/4'],
      browserMode: 'headless',
      channel: 'msedge',
      json: true,
    });
    expect(args.site.id).toBe('docofcard');
  });

  it.each([
    [['--site', 'nowhere']],
    [['--browse-mode', 'slow']],
    [['--run-mode', 'topics:0']],
    [['--headed', '--headless']],
    [['--channel', 'firefox']],
    [['--profile', '../x']],
    [['--unknown']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseRunArgs(argv)).toThrow(UsageError);
  });

  it('parses the §9.3 run mode syntax', () => {
    expect(parseRunMode('endless')).toEqual({ kind: 'endless' });
    expect(parseRunMode('topics:30')).toEqual({ kind: 'topics', min: 30, max: 30 });
    expect(parseRunMode('topics:15-40')).toEqual({ kind: 'topics', min: 15, max: 40 });
    expect(parseRunMode('time:30')).toEqual({ kind: 'time', minutes: 30 });
    expect(() => parseRunMode('topics:40-15')).toThrow(UsageError);
    expect(() => parseRunMode('time:0')).toThrow(UsageError);
  });

  it('lurk login takes site, profile and channel only', () => {
    expect(parseLoginArgs(['--site', 'docofcard', '--profile', 'main'])).toMatchObject({ profile: 'main', channel: 'chrome' });
    expect(() => parseLoginArgs(['--site', 'docofcard', '--headless'])).toThrow(UsageError);
  });

  it('addresses a Profile as <site>/<name>', () => {
    expect(parseProfileId('docofcard/main')).toEqual({ siteId: 'docofcard', name: 'main' });
    expect(() => parseProfileId('docofcard')).toThrow(UsageError);
    expect(() => parseProfileId('a/b/c')).toThrow(UsageError);
  });
});

describe('CLI-002 categories for a run', () => {
  const stored: Category[] = [
    { name: '卡片交流', path: '/c/bank/6', id: 6, enabledByDefault: false },
    { name: 'General', path: '/c/general/4', id: 4, enabledByDefault: true },
  ];

  it('uses the enabled categories when none are named', () => {
    expect(resolveCategories(linuxdo, linuxdo.builtinCategories!, null)).toHaveLength(12);
    expect(resolveCategories(docofcard, stored, null).map((c) => c.path)).toEqual(['/c/general/4']);
    expect(resolveCategories(docofcard, [], null)).toEqual([]);
  });

  it('resolves slugs and paths, including paths not discovered yet', () => {
    expect(resolveCategories(docofcard, stored, ['bank', '/c/market/10']).map((c) => [c.path, c.id])).toEqual([
      ['/c/bank/6', 6],
      ['/c/market/10', 10],
    ]);
    expect(() => resolveCategories(docofcard, stored, ['market'])).toThrow(UsageError);
  });

  it('builds a plan with interactions off and the target fixed from the seed', () => {
    const args = parseRunArgs(['--site', 'linuxdo', '--browse-mode', 'quick', '--run-mode', 'topics:15-40']);
    const a = buildPlan(args, linuxdo.builtinCategories!.slice(0, 2), 42, new Date('2026-10-08T00:00:00Z'));
    const b = buildPlan(args, linuxdo.builtinCategories!.slice(0, 2), 42, new Date('2026-10-08T00:00:00Z'));
    expect(a.preset.runMode).toEqual(b.preset.runMode);
    expect(a.preset.runMode.kind === 'topics' && a.preset.runMode.count >= 15 && a.preset.runMode.count <= 40).toBe(true);
    expect(a.preset.interaction.like.enabled).toBe(false);
    expect(a.preset.interaction.reply.enabled).toBe(false);
    expect(a.profileId).toBe('linuxdo/default');
  });
});

describe('CLI-003 exit codes (§11.1)', () => {
  it.each([
    [{ outcome: 'completed', stopCause: 'target' }, EXIT.ok],
    [{ outcome: 'completed', stopCause: 'user' }, EXIT.cancelled],
    [{ outcome: 'cancelled', stopCause: 'app-exit' }, EXIT.cancelled],
    [{ outcome: 'cancelled', stopCause: 'user' }, EXIT.cancelled],
    [{ outcome: 'cancelled', stopCause: 'error', failure: { code: 'needs-auth', message: '' } }, EXIT.needsAuth],
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'challenge-detected', message: '' } }, EXIT.needsAuth],
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'browser-missing', message: '' } }, EXIT.environment],
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'profile-locked', message: '' } }, EXIT.environment],
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'selector-contract-broken', message: '' } }, EXIT.contract],
    [{ outcome: 'failed', stopCause: 'no-progress', failure: { code: 'no-progress', message: '' } }, EXIT.noProgress],
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'no-candidates', message: '' } }, EXIT.noProgress],
    [{ outcome: 'failed', stopCause: 'user', failure: { code: 'page-timeout', message: '' } }, EXIT.environment],
  ] as const)('%j → %i', (result, code) => {
    expect(exitCodeFor(result)).toBe(code);
  });
});

describe('B10 credentials only from the environment, only for password sites', () => {
  it('ignores LURK_USERNAME / LURK_PASSWORD on headed-login sites', () => {
    const env = { LURK_USERNAME: 'u', LURK_PASSWORD: 'p' };
    expect(credentialsFromEnv(linuxdo, env)).toBeUndefined();
    expect(credentialsFromEnv({ ...linuxdo, login: 'password' }, env)).toEqual({ username: 'u', password: 'p' });
    expect(credentialsFromEnv({ ...linuxdo, login: 'password' }, {})).toBeUndefined();
  });
});
