import { RunError, type LevelMetric, type LevelSnapshot } from '@disco-lurk/core';
import type { DomRoot } from '../parse';
import type { ProgressModule } from './types';

/** The docofcard trust level page (`/my/trust-level`), covering both TL0→1 and TL2→3 row labels. */
export const trustLevelDocofcard: ProgressModule = {
  source: 'trust-level-docofcard',
  labelMap: {
    // TL0 → TL1
    进入过的主题: 'topicsViewed',
    已读帖子: 'postsRead',
    '阅读时间（分钟）': 'readingTime',
    '注册时长（分钟）': 'other',
    // TL2 → TL3
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
  },
};

const P = '.docofcard-tools-trust-level-progress';

export const TRUST_LEVEL_SELECTORS = {
  container: P,
  loader: `${P}-loader`,
  levelName: `${P}__level-name`,
  percent: `${P}__percent`,
  nextName: `${P}__next ${P}__next-name`,
  table: `${P}__table`,
  rows: `${P}__table tbody tr`,
  indicator: `${P}__indicator`,
} as const;

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** First integer token in a cell (e.g. `12% (12 / 100 天数)` → 12, `最多 5 个` → 5, `7,797` → 7797). */
const firstInt = (raw: string | null | undefined): number | null => {
  const m = /\d[\d,]*/.exec(raw ?? '');
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

const isLimitRequirement = (raw: string) => /最多|\bat most\b/i.test(raw);

type TrustLevelPage = { state: 'loading' } | { state: 'ready'; snapshot: LevelSnapshot };

/**
 * The page renders a loader before its table; until a table row exists it reports
 * `loading`, and the caller keeps waiting. Without container or loader the contract is broken.
 */
export function parseTrustLevel(root: DomRoot): TrustLevelPage {
  const S = TRUST_LEVEL_SELECTORS;
  const rows = Array.from(root.querySelectorAll(S.rows));
  if (rows.length === 0) {
    if (root.querySelector(S.loader) || root.querySelector(S.container)) return { state: 'loading' };
    throw new RunError('selector-contract-broken', `trust level page has no ${S.container}`);
  }
  const metrics: LevelMetric[] = [];
  for (const row of rows) {
    if (!row.matches('tr.is-complete, tr.is-incomplete')) continue;
    // The requirement name is a row header (`th scope="row"`), so cells are counted across th and td.
    const cells = Array.from(row.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
    const label = text(cells[0]);
    const current = firstInt(cells[2]?.textContent);
    if (!label || current === null) continue;
    const requiredText = text(cells[3]);
    const limit = isLimitRequirement(requiredText);
    metrics.push({
      label,
      key: trustLevelDocofcard.labelMap[label] ?? 'other',
      current,
      required: firstInt(requiredText),
      ...(limit ? { limit: true as const } : {}),
    });
  }
  if (metrics.length === 0) throw new RunError('selector-contract-broken', 'trust level table rows carry no is-complete / is-incomplete data');

  const snapshot: LevelSnapshot = { source: 'trust-level-docofcard', metrics };
  const level = text(root.querySelector(S.levelName));
  if (level) snapshot.level = level;
  const next = text(root.querySelector(S.nextName));
  if (next) snapshot.nextLevel = next;
  const percent = /(\d+)%/.exec(text(root.querySelector(S.percent)));
  if (percent) snapshot.percent = Number(percent[1]);
  return { state: 'ready', snapshot };
}
