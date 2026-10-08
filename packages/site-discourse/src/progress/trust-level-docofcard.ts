import { RunError, type LevelMetric, type LevelSnapshot } from '@disco-lurk/core';
import { toInt, type DomRoot } from '../parse';
import type { ProgressModule } from './types';

/** §5.1b */
export const trustLevelDocofcard: ProgressModule = {
  source: 'trust-level-docofcard',
  labelMap: {
    进入过的主题: 'topicsViewed',
    已读帖子: 'postsRead',
    '阅读时间（分钟）': 'readingTime',
    '注册时长（分钟）': 'other',
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

export type TrustLevelPage = { state: 'loading' } | { state: 'ready'; snapshot: LevelSnapshot };

/**
 * §5.1b. The page renders a loader before its table; until a table row exists it reports
 * `loading`, and the caller keeps waiting (S07). Without container or loader the contract is broken.
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
    const current = toInt(cells[2]?.textContent);
    if (!label || current === null) continue;
    metrics.push({ label, key: trustLevelDocofcard.labelMap[label] ?? 'other', current, required: toInt(cells[3]?.textContent) });
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
