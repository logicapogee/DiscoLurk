import { ESTIMATE, RunError, estimateMetrics, type LevelSnapshot, type MetricKey, type RunStats } from '@disco-lurk/core';
import {
  LABEL_MAP,
  TRUST_LEVEL_SELECTORS,
  parseConnect,
  parseDocument,
  parseTrustLevel,
  progressModuleFor,
} from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { SITE_IDS, fixture, textOf, type SiteId } from './fixtures';

/** §5.1 LABEL_MAP, transcribed label by label. */
const CONNECT_KEYS: Record<string, MetricKey> = {
  浏览话题: 'topicsViewed',
  浏览帖子: 'postsRead',
  回复话题: 'repliesPosted',
  点赞: 'likesGiven',
  获赞: 'likesReceived',
  被举报帖子: 'flagged',
  被禁言: 'silenced',
  被封禁: 'suspended',
  访问天数: 'other',
  获赞天数: 'other',
  获赞用户: 'other',
  举报用户: 'other',
};

/** §5.1b mapping (TL0→1 and TL2→3 labels on docofcard). */
const TRUST_LEVEL_KEYS: Record<string, MetricKey> = {
  进入过的主题: 'topicsViewed',
  已读帖子: 'postsRead',
  '阅读时间（分钟）': 'readingTime',
  '注册时长（分钟）': 'other',
  回复的话题: 'repliesPosted',
  浏览的话题: 'topicsViewed',
  '浏览的话题（所有时间）': 'other',
  连续有效活跃天数: 'other',
  '已读帖子（所有时间）': 'other',
  被举报的帖子: 'flagged',
  发起举报的用户: 'other',
  点赞: 'likesGiven',
  获赞: 'likesReceived',
  '获赞：被点赞的天数': 'other',
  '获赞：点赞用户数量': 'other',
  '被禁言（过去 6 个月）': 'silenced',
  '被封禁（过去 6 个月）': 'suspended',
};

/** Values on tests/fixtures/linuxdo/connect.html, in page order. */
const CONNECT_ROWS: Array<[label: string, current: number, required: number]> = [
  ['访问天数', 57, 50],
  ['浏览话题', 543, 500],
  ['浏览帖子', 15466, 20000],
  ['回复话题', 24, 10],
  ['点赞', 31, 30],
  ['获赞', 113, 20],
  ['获赞天数', 38, 7],
  ['获赞用户', 107, 5],
  ['被举报帖子', 0, 5],
  ['举报用户', 0, 5],
  ['被禁言', 0, 0],
  ['被封禁', 0, 0],
];

/** Values on tests/fixtures/docofcard/trust-level.html (TL2→3), in page order. */
const TRUST_LEVEL_ROWS: Array<[label: string, indicator: '✓' | '×', current: number, required: number, complete: boolean, limit?: true]> = [
  ['回复的话题', '×', 15, 100, false],
  ['浏览的话题', '✓', 229, 196, true],
  ['浏览的话题（所有时间）', '×', 229, 300, false],
  ['已读帖子', '✓', 7797, 2000, true],
  ['连续有效活跃天数', '×', 12, 100, false],
  ['已读帖子（所有时间）', '✓', 7797, 1000, true],
  ['被举报的帖子', '✓', 0, 5, true, true],
  ['发起举报的用户', '✓', 0, 5, true, true],
  ['点赞', '×', 7, 30, false],
  ['获赞', '×', 8, 20, false],
  ['获赞：被点赞的天数', '×', 4, 7, false],
  ['获赞：点赞用户数量', '✓', 7, 5, true],
  ['被禁言（过去 6 个月）', '✓', 0, 0, true, true],
  ['被封禁（过去 6 个月）', '✓', 0, 0, true, true],
];

const EMPTY = () => parseDocument('<!doctype html><html><body><main></main></body></html>');

function contractBroken(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    return e instanceof RunError && e.code === 'selector-contract-broken';
  }
  return false;
}

/** Each site parsed through the module its `progressSource` selects. */
function readProgress(site: SiteId): LevelSnapshot {
  if (site === 'linuxdo') return parseConnect(fixture(site, 'connect.html'));
  const page = parseTrustLevel(fixture(site, 'trust-level.html'));
  if (page.state !== 'ready') throw new Error('trust-level.html did not parse as ready');
  return page.snapshot;
}

const SOURCE = { linuxdo: 'connect-linuxdo', docofcard: 'trust-level-docofcard' } as const;

describe.each(SITE_IDS)('progress page parsed by its progressSource (§5) — %s', (site) => {
  const snapshot = readProgress(site);

  it('tags the snapshot with the source the site selects', () => {
    expect(snapshot.source).toBe(SOURCE[site]);
    expect(progressModuleFor({ progressSource: SOURCE[site] })?.source).toBe(SOURCE[site]);
  });

  it('maps every metric through that source’s LABEL_MAP', () => {
    for (const m of snapshot.metrics) expect(m.key, m.label).toBe(LABEL_MAP[SOURCE[site]][m.label]);
  });
});

describe('CONNECT-001 connect.linux.do parsing (§5.1)', () => {
  const snapshot = parseConnect(fixture('linuxdo', 'connect.html'));

  it('reads all 12 metrics from tl3-ring / bar / quota / veto with current and required', () => {
    expect(snapshot.metrics.map((m) => [m.label, m.current, m.required])).toEqual(CONNECT_ROWS);
  });

  it('reads the username and derives the current level from the target level', () => {
    expect(snapshot.username).toBe('user1');
    expect(snapshot.nextLevel).toBe(3);
    expect(snapshot.level).toBe(2);
  });

  it('fixes the required value of veto items at 0', () => {
    for (const label of ['被禁言', '被封禁']) expect(snapshot.metrics.find((m) => m.label === label)?.required).toBe(0);
  });

  it('marks quota and veto items as limits and the rest as goals', () => {
    expect(snapshot.metrics.filter((m) => m.limit).map((m) => m.label)).toEqual(['被举报帖子', '举报用户', '被禁言', '被封禁']);
  });

  it('reports selector-contract-broken when every tl3 group is missing', () => {
    expect(contractBroken(() => parseConnect(EMPTY()))).toBe(true);
  });
});

describe('CONNECT-002 metric keys and estimation (§5.2)', () => {
  it.each(Object.entries(CONNECT_KEYS))('connect label %s maps to %s', (label, key) => {
    expect(LABEL_MAP['connect-linuxdo'][label]).toBe(key);
    expect(parseConnect(fixture('linuxdo', 'connect.html')).metrics.find((m) => m.label === label)?.key).toBe(key);
  });

  it('holds the 12 §5.1 labels for connect and the TL0→1 + TL2→3 labels for the trust level page', () => {
    expect(LABEL_MAP['connect-linuxdo']).toEqual(CONNECT_KEYS);
    expect(LABEL_MAP['trust-level-docofcard']).toEqual(TRUST_LEVEL_KEYS);
  });

  it('estimates exactly topicsViewed, postsRead, likesGiven and repliesPosted', () => {
    expect(Object.keys(ESTIMATE).sort()).toEqual(['likesGiven', 'postsRead', 'repliesPosted', 'topicsViewed']);
  });

  const stats: RunStats = {
    attempted: { topics: 9, floors: 90, likes: 9, replyLikes: 9, replies: 9 },
    confirmed: { topics: 5, floors: 40, likes: 2, replyLikes: 3, replies: 4, repliedTopics: 1 },
    estimatedFloors: 7,
    returns: { confirmed: 3, 'still-unread': 1, indeterminate: 1, 'not-applicable': 0 },
    timings: { posts: 38, topicSeconds: 120 },
    elapsedMs: 1000,
  };

  it('adds the confirmed local delta to those four keys and leaves every other metric unestimated', () => {
    const estimated = estimateMetrics(parseConnect(fixture('linuxdo', 'connect.html')), stats);
    const byLabel = Object.fromEntries(estimated.map((m) => [m.label, m.estimated]));
    expect(byLabel).toEqual({
      访问天数: null,
      浏览话题: 543 + 5,
      浏览帖子: 15466 + 40,
      回复话题: 24 + 1,
      点赞: 31 + 2 + 3,
      获赞: null,
      获赞天数: null,
      获赞用户: null,
      被举报帖子: null,
      举报用户: null,
      被禁言: null,
      被封禁: null,
    });
  });

  it('estimates the four countable keys on docofcard TL2→3 and leaves readingTime and other labels unestimated', () => {
    const estimated = estimateMetrics(readProgress('docofcard'), stats);
    expect(Object.fromEntries(estimated.map((m) => [m.label, m.estimated]))).toEqual({
      回复的话题: 15 + 1,
      浏览的话题: 229 + 5,
      '浏览的话题（所有时间）': null,
      已读帖子: 7797 + 40,
      连续有效活跃天数: null,
      '已读帖子（所有时间）': null,
      被举报的帖子: null,
      发起举报的用户: null,
      点赞: 7 + 2 + 3,
      获赞: null,
      '获赞：被点赞的天数': null,
      '获赞：点赞用户数量': null,
      '被禁言（过去 6 个月）': null,
      '被封禁（过去 6 个月）': null,
    });
    const tl0 = parseTrustLevel(
      parseDocument(
        '<table class="docofcard-tools-trust-level-progress__table"><tbody>' +
          '<tr class="is-complete"><th scope="row">进入过的主题</th><td>✓</td><td>25</td><td>5</td></tr>' +
          '<tr class="is-complete"><th scope="row">已读帖子</th><td>✓</td><td>193</td><td>30</td></tr>' +
          '<tr class="is-incomplete"><th scope="row">阅读时间（分钟）</th><td>×</td><td>19</td><td>30</td></tr>' +
          '<tr class="is-complete"><th scope="row">注册时长（分钟）</th><td>✓</td><td>31008</td><td>30</td></tr>' +
          '</tbody></table>',
      ),
    );
    expect(tl0.state).toBe('ready');
    if (tl0.state !== 'ready') return;
    expect(Object.fromEntries(estimateMetrics(tl0.snapshot, stats).map((m) => [m.label, m.estimated]))).toEqual({
      进入过的主题: 25 + 5,
      已读帖子: 193 + 40,
      '阅读时间（分钟）': null,
      '注册时长（分钟）': null,
    });
  });

  it('estimates nothing without a baseline, as with progressSource none', () => {
    expect(progressModuleFor({ progressSource: 'none' })).toBeNull();
    expect(estimateMetrics(null, stats)).toEqual([]);
  });
});

describe('TRUSTLEVEL-001 docofcard trust level page (§5.1b)', () => {
  const S = TRUST_LEVEL_SELECTORS;
  const ready = fixture('docofcard', 'trust-level.html');
  const loader = fixture('docofcard', 'trust-level-loader.html');

  it('reads level name, percent and next level', () => {
    const page = parseTrustLevel(ready);
    expect(page.state).toBe('ready');
    if (page.state !== 'ready') return;
    expect(page.snapshot.level).toBe('被历史铭记之人');
    expect(page.snapshot.percent).toBe(73);
    expect(page.snapshot.nextLevel).toBe('世界意志承载者');
  });

  it('reads every requirement row: th[scope=row] name, indicator, current, required, completion class and limits', () => {
    const rows = Array.from(ready.querySelectorAll(S.rows)).map((tr) => {
      const cells = Array.from(tr.children);
      expect(cells.map((c) => c.tagName)).toEqual(['TH', 'TD', 'TD', 'TD']);
      expect(cells[0]!.getAttribute('scope')).toBe('row');
      expect(cells[1]!.matches(S.indicator)).toBe(true);
      expect(tr.matches('.is-complete') !== tr.matches('.is-incomplete')).toBe(true);
      const reqText = textOf(cells[3]);
      return [
        textOf(cells[0]),
        textOf(cells[1]),
        Number(/\d[\d,]*/.exec(textOf(cells[2]))![0].replace(/,/g, '')),
        Number(/\d[\d,]*/.exec(reqText)![0].replace(/,/g, '')),
        tr.matches('.is-complete'),
        ...(reqText.includes('最多') ? ([true] as const) : []),
      ];
    });
    expect(rows).toEqual(TRUST_LEVEL_ROWS);
  });

  it('turns each row into a metric with its MetricKey and limit flag', () => {
    const page = parseTrustLevel(ready);
    if (page.state !== 'ready') throw new Error('not ready');
    expect(page.snapshot.metrics).toEqual(
      TRUST_LEVEL_ROWS.map(([label, , current, required, , limit]) => ({
        label,
        key: TRUST_LEVEL_KEYS[label],
        current,
        required,
        ...(limit ? { limit: true } : {}),
      })),
    );
  });

  it('keeps the loader in the DOM after the table renders, so readiness rests on table rows', () => {
    expect(ready.querySelectorAll(S.loader).length).toBe(1);
    expect(ready.querySelectorAll(S.rows).length).toBe(14);
  });

  it('reports the loader-only page as not ready rather than a broken contract', () => {
    expect(loader.querySelectorAll(S.rows).length).toBe(0);
    expect(contractBroken(() => parseTrustLevel(loader))).toBe(false);
    expect(parseTrustLevel(loader)).toEqual({ state: 'loading' });
  });

  it('reports selector-contract-broken when neither container nor loader exists', () => {
    expect(contractBroken(() => parseTrustLevel(EMPTY()))).toBe(true);
  });
});
