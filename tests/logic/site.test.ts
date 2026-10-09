import { browse, EXPERIMENTS_OFF, TimingsTally, type Site, type TopicCandidate } from '@disco-lurk/core';
import { FixtureForum, fixtureSite, VirtualTime } from '@disco-lurk/core/testing';
import { loadBuiltinSites, validateSite } from '@disco-lurk/config';
import { progressModuleFor } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { readData } from './data';

const sites = () => loadBuiltinSites(readData('sites.json') as never, readData);

const minimal = (): Record<string, unknown> => ({ ...fixtureSite({ id: 'example', displayName: 'Example', baseUrl: 'https://forum.example.org' }) });

describe('SITE-001 site configuration (§2.2)', () => {
  it('loads both built-in sites with the §2.2 settings', () => {
    const [linuxdo, docofcard] = sites();
    expect(linuxdo).toMatchObject({
      id: 'linuxdo',
      categorySource: 'builtin',
      progressSource: 'connect-linuxdo',
      behaviorVerified: { clickEntryRequired: true },
    });
    expect(linuxdo?.builtinCategories).toHaveLength(16);
    expect(linuxdo?.builtinCategories?.filter((c) => !c.enabledByDefault).map((c) => c.path)).toEqual([
      '/c/credit/106',
      '/c/startup/46',
      '/c/incubator/102',
      '/c/feedback/2',
    ]);
    expect(docofcard).toMatchObject({
      id: 'docofcard',
      categorySource: 'discovered',
      progressSource: 'trust-level-docofcard',
      progressUrl: 'https://forum.docofcard.com/my/trust-level',
      // Phase 1 T1: opening topics by address also raised 进入过的主题 on docofcard.
      behaviorVerified: { clickEntryRequired: false },
    });
    expect(docofcard?.builtinCategories).toBeUndefined();
  });

  it('accepts a minimal user-added site', () => {
    expect(validateSite(minimal()).ok).toBe(true);
  });

  it.each(['id', 'displayName', 'baseUrl', 'kind', 'login', 'categorySource', 'progressSource', 'behaviorVerified'])(
    'rejects a site without %s',
    (field) => {
      const site = minimal();
      delete site[field];
      expect(validateSite(site).ok).toBe(false);
    },
  );

  it('allows only kind "discourse"', () => {
    expect(validateSite({ ...minimal(), kind: 'flarum' }).ok).toBe(false);
  });

  it('ties source fields to their data', () => {
    expect(validateSite({ ...minimal(), categorySource: 'builtin' }).ok).toBe(false);
    expect(validateSite({ ...minimal(), progressSource: 'connect-linuxdo' }).ok).toBe(false);
    expect(validateSite({ ...minimal(), behaviorVerified: { clickEntryRequired: 'maybe' } }).ok).toBe(false);
    expect(validateSite({ ...minimal(), extra: 1 }).ok).toBe(false);
  });

  it('selects the progress implementation from progressSource', () => {
    const [linuxdo, docofcard] = sites();
    expect(progressModuleFor(linuxdo!)?.source).toBe('connect-linuxdo');
    expect(progressModuleFor(docofcard!)?.source).toBe('trust-level-docofcard');
    expect(progressModuleFor({ progressSource: 'none' })).toBeNull();
  });

  it('still enters every topic by list click when clickEntryRequired is "unverified" (T08)', async () => {
    const docofcard: Site = { ...(sites()[1] as Site), behaviorVerified: { clickEntryRequired: 'unverified' } };
    const time = new VirtualTime();
    const topics = (path: string, call: number): TopicCandidate[] => [
      { id: `${path}:${call}`, title: 't', unread: true, pinned: false },
    ];
    const forum = new FixtureForum({ site: docofcard, sleeper: time.sleeper, topics });
    const categories = [{ name: 'a', path: '/c/a/1', id: 1, enabledByDefault: true }];
    const out = await time.drive(
      browse({
        plan: {
          id: 'r',
          siteId: docofcard.id,
          profileId: 'main',
          browserMode: 'headless',
          seed: 3,
          plannedAt: '',
          materializedAt: '',
          preset: {
            presetId: 'p',
            browseMode: 'quick',
            runMode: { kind: 'topics', count: 3 },
            categories,
            interaction: {
              like: { enabled: false, topicRate: 30, replyRate: 15, maxReplies: 4 },
              reply: { enabled: false, rate: 5, riskAcknowledged: false },
            },
            extraWait: { enabled: false, minSec: 1, maxSec: 3 },
            samplePerCategory: { min: 3, max: 8 },
            experiments: { ...EXPERIMENTS_OFF },
          },
        },
        forum,
        deps: time.deps(3),
        signal: new AbortController().signal,
        emit: () => {},
        categories,
        timings: new TimingsTally(),
      }),
    );
    expect(out.stats.confirmed.topics).toBe(3);
    const reads = forum.calls.filter((c) => c.op === 'readTopic').map((c) => (c as { topicId: string }).topicId);
    const entries = forum.calls.filter((c) => c.op === 'enterFromList').map((c) => (c as { topicId: string }).topicId);
    expect(entries).toHaveLength(3);
    expect(reads.every((id) => entries.includes(id))).toBe(true);
    expect(new Set(forum.calls.map((c) => c.op))).toEqual(new Set(['collectTopics', 'enterFromList', 'readTopic', 'returnAndVerify']));
  });
});
