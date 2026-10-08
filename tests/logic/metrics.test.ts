import { emptyStats, estimateMetrics, ESTIMATE, type LevelSnapshot, type MetricKey } from '@disco-lurk/core';
import { LABEL_MAP, mapLabel, parseConnect, PROGRESS_MODULES } from '@disco-lurk/site-discourse';
import { describe, expect, it } from 'vitest';
import { fixture } from '../dom/fixtures';

describe('CONNECT-002 metric keys and estimates (§5.2)', () => {
  it('keeps one label map per progress source', () => {
    expect(Object.keys(LABEL_MAP).sort()).toEqual(['connect-linuxdo', 'trust-level-docofcard']);
  });

  it('maps the docofcard trust-level labels from §5.1b', () => {
    const m = PROGRESS_MODULES['trust-level-docofcard'];
    expect(mapLabel(m, '进入过的主题')).toBe('topicsViewed');
    expect(mapLabel(m, '已读帖子')).toBe('postsRead');
    expect(mapLabel(m, '阅读时间（分钟）')).toBe('readingTime');
    expect(mapLabel(m, '注册时长（分钟）')).toBe('other');
  });

  it('maps every connect label in the linuxdo fixture, and only those, through the connect map', () => {
    const labels = parseConnect(fixture('linuxdo', 'connect.html')).metrics.map((m) => m.label);
    expect(labels.sort()).toEqual(Object.keys(LABEL_MAP['connect-linuxdo']).sort());
    const m = PROGRESS_MODULES['connect-linuxdo'];
    expect(Object.fromEntries(labels.map((l) => [l, mapLabel(m, l)]))).toEqual({
      访问天数: 'other',
      浏览话题: 'topicsViewed',
      浏览帖子: 'postsRead',
      回复话题: 'repliesPosted',
      点赞: 'likesGiven',
      获赞: 'likesReceived',
      获赞天数: 'other',
      获赞用户: 'other',
      被举报帖子: 'flagged',
      举报用户: 'other',
      被禁言: 'silenced',
      被封禁: 'suspended',
    });
  });

  it('maps unknown labels to other for every source', () => {
    for (const m of Object.values(PROGRESS_MODULES)) expect(mapLabel(m, '成就点数')).toBe('other');
  });

  it('estimates exactly the four explicit keys', () => {
    expect(Object.keys(ESTIMATE).sort()).toEqual(['likesGiven', 'postsRead', 'repliesPosted', 'topicsViewed']);
  });

  it('adds confirmed counts to the baseline only for estimated keys', () => {
    const keys: MetricKey[] = ['topicsViewed', 'postsRead', 'readingTime', 'likesGiven', 'likesReceived', 'repliesPosted', 'other'];
    const initial: LevelSnapshot = {
      source: 'trust-level-docofcard',
      metrics: keys.map((key, i) => ({ label: key, key, current: 100 * (i + 1), required: null })),
    };
    const stats = emptyStats();
    stats.confirmed = { topics: 2, floors: 30, likes: 1, replyLikes: 2, replies: 3, repliedTopics: 1 };
    stats.attempted = { topics: 9, floors: 99, likes: 9, replyLikes: 9, replies: 9 };
    stats.estimatedFloors = 500;
    const byKey = Object.fromEntries(estimateMetrics(initial, stats).map((m) => [m.key, m.estimated]));
    expect(byKey).toEqual({
      topicsViewed: 102,
      postsRead: 230,
      readingTime: null,
      likesGiven: 403,
      likesReceived: null,
      repliesPosted: 601,
      other: null,
    });
  });

  it('estimates nothing without a progress page (progressSource none) or baseline', () => {
    expect(estimateMetrics(null, emptyStats())).toEqual([]);
  });
});
