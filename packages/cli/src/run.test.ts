import { describe, expect, it } from 'vitest';
import { emptyStats, type AuthResult, type AuthSession, type Category, type RunResult } from '@disco-lurk/core';
import {
  buildPlan,
  createReporter,
  credentialsFromEnv,
  EXIT,
  exitCodeFor,
  formatSummary,
  parseLoginArgs,
  parseProfileId,
  parseRunArgs,
  parseRunMode,
  REPLY_RISK_NOTICE,
  replyTemplates,
  resolveCategories,
  signIn,
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
    [{ outcome: 'failed', stopCause: 'error', failure: { code: 'internal', message: 'page crashed' } }, EXIT.environment],
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

describe('CLI-002 run output (§11.1)', () => {
  const result: RunResult = {
    outcome: 'completed',
    stopCause: 'target',
    stats: emptyStats(),
    baseline: 'not-applicable',
    levels: { initial: null, final: null },
  };
  const plan = buildPlan(parseRunArgs(['--site', 'linuxdo']), [], 1, new Date('2026-10-08T00:00:00Z'));

  it('--json prints one JSON object per line: plan, events, result', () => {
    const lines: string[] = [];
    const r = createReporter(true, 0, (l) => lines.push(l));
    r.plan(plan, 'intro');
    r.event({ type: 'state', at: '2026-10-08T00:00:01.000Z', state: 'queued' });
    r.result(result);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['plan', 'state', 'result']);
  });

  it('human output prints the intro, timed event lines and the summary, and skips stats events', () => {
    const lines: string[] = [];
    const r = createReporter(false, Date.parse('2026-10-08T00:00:00Z'), (l) => lines.push(l));
    r.plan(plan, 'intro');
    r.event({ type: 'state', at: '2026-10-08T00:01:05.000Z', state: 'browsing' });
    r.event({ type: 'stats', at: '2026-10-08T00:01:05.000Z', stats: emptyStats() });
    r.result(result);
    expect(lines.slice(0, 2)).toEqual(['intro', '[01:05] state browsing']);
    expect(lines[2]).toMatch(/^\nresult: completed \(target\)/);
    expect(lines).toHaveLength(3);
  });

  it('prints a levels event as one summary line in human output and as-is in JSON', () => {
    const snapshot = { source: 'connect-linuxdo' as const, username: 'alice', level: 2, percent: 45, metrics: [{ label: '浏览话题', key: 'topicsViewed' as const, current: 120, required: 500 }] };
    const event = { type: 'levels' as const, at: '2026-10-08T00:00:03.000Z', kind: 'initial' as const, snapshot };
    const human: string[] = [];
    createReporter(false, Date.parse('2026-10-08T00:00:00Z'), (l) => human.push(l)).event(event);
    expect(human).toEqual(['[00:03] site progress (initial): @alice · level 2 · 45% · 1 metrics']);
    const json: string[] = [];
    createReporter(true, 0, (l) => json.push(l)).event(event);
    expect(JSON.parse(json[0]!)).toEqual(event);
  });

  it('S08: adds the lag note only when the site shows fewer topics than were confirmed', () => {
    const withViewed = (confirmed: number, initial: number, final: number): RunResult => {
      const stats = emptyStats();
      stats.confirmed.topics = confirmed;
      stats.reported = { topicsViewed: { initial, final } };
      return { ...result, baseline: 'present', stats };
    };
    expect(formatSummary(withViewed(3, 100, 101))).toContain('site statistics may lag: the site shows 2 fewer topics than confirmed');
    expect(formatSummary(withViewed(3, 100, 101))).toContain('confirmed: topics 3');
    expect(formatSummary(withViewed(3, 100, 103))).not.toContain('may lag');
    expect(formatSummary(result)).not.toContain('may lag');
  });
});

describe('lurk login (§11.1)', () => {
  function session(answer: () => Promise<AuthResult>) {
    const calls: string[] = [];
    const auth: AuthSession = {
      recheck: async () => {
        calls.push('recheck');
        return { status: 'authenticated' };
      },
      continueWaiting: async () => {
        calls.push('continueWaiting');
        return answer();
      },
      close: async () => {
        calls.push('close');
      },
    };
    return { auth, calls };
  }

  it('succeeds on #current-user in the headed window and runs no headless check afterwards', async () => {
    const { auth, calls } = session(async () => ({ status: 'authenticated', username: 'alice' }));
    const lines: string[] = [];
    expect(await signIn(auth, new AbortController().signal, (l) => lines.push(l))).toBe(EXIT.ok);
    expect(calls).toEqual(['continueWaiting', 'close']);
    expect(lines).toEqual(['Signed in as alice.']);
  });

  it('maps a timed-out wait to exit 3 and a stop to exit 2, closing the browser either way', async () => {
    const timedOut = session(async () => ({ status: 'needs-auth' }));
    expect(await signIn(timedOut.auth, new AbortController().signal, () => {})).toBe(EXIT.needsAuth);
    expect(timedOut.calls).toEqual(['continueWaiting', 'close']);
    const stopped = session(() => Promise.reject(new DOMException('user', 'AbortError')));
    expect(await signIn(stopped.auth, new AbortController().signal, () => {})).toBe(EXIT.cancelled);
    expect(stopped.calls).toEqual(['continueWaiting', 'close']);
  });
});

describe('ACTION-000 likes and replies from the command line (A01, A02, §11.1)', () => {
  it('leaves both off by default at the default rates, with the extra wait on and every experiment off', () => {
    const args = parseRunArgs([]);
    expect(args.interaction).toEqual({ like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 }, reply: { enabled: false, rate: 5 } });
    expect(args.extraWait).toEqual({ enabled: true, minSec: 1, maxSec: 3 });
    expect(args.experiments).toEqual({ useNewList: false, useUnreadList: false, refreshCategories: false, smartRanked: false });
  });

  it('turns likes on with their rates', () => {
    const args = parseRunArgs(['--like', '--like-rate', '50', '--reply-like-rate', '10', '--max-reply-likes', '2']);
    expect(args.interaction.like).toEqual({ enabled: true, topicRate: 50, replyRate: 10, maxReplies: 2 });
    expect(args.interaction.reply.enabled).toBe(false);
  });

  it('refuses --reply without the explicit risk confirmation, naming the risk', () => {
    expect(() => parseRunArgs(['--reply'])).toThrow(UsageError);
    expect(() => parseRunArgs(['--reply'])).toThrow(REPLY_RISK_NOTICE);
    const args = parseRunArgs(['--reply', '--i-understand-auto-reply-risk', '--reply-rate', '20']);
    expect(args.interaction.reply).toEqual({ enabled: true, rate: 20 });
  });

  it('the risk flag alone turns nothing on', () => {
    expect(parseRunArgs(['--i-understand-auto-reply-risk']).interaction.reply.enabled).toBe(false);
  });

  it.each([[['--like-rate', '101']], [['--reply-like-rate', '-1']], [['--max-reply-likes', '2.5']], [['--extra-wait', '3-1']], [['--experiments', 'turbo']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseRunArgs(argv)).toThrow(UsageError);
    },
  );

  it('reads the extra wait and the experiments', () => {
    expect(parseRunArgs(['--extra-wait', 'off']).extraWait.enabled).toBe(false);
    expect(parseRunArgs(['--extra-wait', '2-4.5']).extraWait).toEqual({ enabled: true, minSec: 2, maxSec: 4.5 });
    expect(parseRunArgs(['--experiments', 'useNewList, smartRanked']).experiments).toEqual({
      useNewList: true,
      useUnreadList: false,
      refreshCategories: false,
      smartRanked: true,
    });
  });

  it('carries the choices into the plan', () => {
    const args = parseRunArgs(['--like', '--extra-wait', 'off', '--experiments', 'useUnreadList']);
    const plan = buildPlan(args, linuxdo.builtinCategories!.slice(0, 1), 1, new Date('2026-10-08T00:00:00Z'));
    expect(plan.preset.interaction.like.enabled).toBe(true);
    expect(plan.preset.extraWait.enabled).toBe(false);
    expect(plan.preset.experiments?.useUnreadList).toBe(true);
  });
});

describe('TPL-001 bundled reply templates', () => {
  it('loads the bundled templates and refuses an invalid set', () => {
    expect(replyTemplates().length).toBeGreaterThanOrEqual(6);
    expect(() => replyTemplates({ templates: ['太短'] })).toThrow(/reply-templates\.json is invalid/);
  });
});
