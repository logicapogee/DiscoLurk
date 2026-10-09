import { RunError, type LevelMetric, type LevelSnapshot } from '@disco-lurk/core';
import { toInt, type DomRoot } from '../parse';
import type { ProgressModule } from './types';

/**
 * Connect's labels as tests/fixtures/linuxdo/connect.html shows them. Counts of days, distinct users
 * and flags raised by the user have no local estimate and stay `other`.
 */
export const connectLinuxdo: ProgressModule = {
  source: 'connect-linuxdo',
  labelMap: {
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
  },
};

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function metric(label: string, current: number | null, required: number | null, limit = false): LevelMetric | null {
  if (!label || current === null) return null;
  return { label, key: connectLinuxdo.labelMap[label] ?? 'other', current, required, ...(limit ? { limit: true as const } : {}) };
}

/** All four `tl3-*` groups; a page with none of them breaks the contract. */
export function parseConnect(root: DomRoot): LevelSnapshot {
  const metrics: LevelMetric[] = [];
  const push = (m: LevelMetric | null) => m && metrics.push(m);

  for (const ring of Array.from(root.querySelectorAll('.tl3-ring'))) {
    push(
      metric(
        text(ring.querySelector('.tl3-ring-label')),
        toInt(ring.querySelector('.tl3-ring-current')?.textContent),
        toInt(text(ring.querySelector('.tl3-ring-target')).replace('/', '')),
      ),
    );
  }
  for (const bar of Array.from(root.querySelectorAll('.tl3-bar-item'))) {
    const nums = /(\d+)\/(\d+)/.exec(text(bar.querySelector('.tl3-bar-nums')));
    push(metric(text(bar.querySelector('.tl3-bar-label')), nums ? Number(nums[1]) : null, nums ? Number(nums[2]) : null));
  }
  for (const card of Array.from(root.querySelectorAll('.tl3-quota-card'))) {
    const nums = /(\d+)\s*\/\s*(\d+)/.exec(text(card.querySelector('.tl3-quota-nums')));
    push(metric(text(card.querySelector('.tl3-quota-label')), nums ? Number(nums[1]) : null, nums ? Number(nums[2]) : null, true));
  }
  for (const veto of Array.from(root.querySelectorAll('.tl3-veto-item'))) {
    push(metric(text(veto.querySelector('.tl3-veto-label')), toInt(veto.querySelector('.tl3-veto-value')?.textContent), 0, true));
  }
  if (metrics.length === 0) {
    throw new RunError('selector-contract-broken', 'connect page has none of tl3-ring / tl3-bar-item / tl3-quota-card / tl3-veto-item');
  }

  const snapshot: LevelSnapshot = { source: 'connect-linuxdo', metrics };
  const username = /@([^\s·]+)/.exec(text(root.querySelector('.card-subtitle')))?.[1];
  if (username) snapshot.username = username;
  const titles = Array.from(root.querySelectorAll('.card-title')).map(text);
  const target = titles.map((t) => /信任级别\s*(\d+)/.exec(t)).find(Boolean);
  if (target) {
    snapshot.nextLevel = Number(target[1]);
    snapshot.level = Number(target[1]) - 1;
  }
  return snapshot;
}
