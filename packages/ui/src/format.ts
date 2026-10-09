import type { BrowseMode, RunEvent, RunMode, RunModeSpec, RunResult, RunStats } from '@disco-lurk/core';
import { copy } from './copy';

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export function runModeSpecText(m: RunModeSpec): string {
  switch (m.kind) {
    case 'endless':
      return copy.run.runModes.endless;
    case 'topics':
      return m.min === m.max ? `${m.min}` : `${m.min}–${m.max}`;
    case 'time':
      return `${m.minutes} ${copy.common.minutes}`;
  }
}

export function runModeText(m: RunMode): string {
  switch (m.kind) {
    case 'endless':
      return copy.run.runModes.endless;
    case 'topics':
      return `${m.count}`;
    case 'time':
      return `${m.minutes} ${copy.common.minutes}`;
  }
}

/** Deep mode counts topics plus floors toward a number target; quick mode counts topics only. */
export function targetProgress(stats: RunStats, browseMode: BrowseMode): number {
  return browseMode === 'deep' ? stats.confirmed.topics + stats.confirmed.floors : stats.confirmed.topics;
}

export function remainingText(mode: RunMode, browseMode: BrowseMode, stats: RunStats | undefined, elapsedMs: number): string | null {
  if (mode.kind === 'topics') return `${Math.max(0, mode.count - (stats ? targetProgress(stats, browseMode) : 0))}`;
  if (mode.kind === 'time') return duration(mode.minutes * 60_000 - elapsedMs);
  return null;
}

export function lastStats(events: readonly RunEvent[]): RunStats | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'stats') return e.stats;
  }
  return undefined;
}

/**
 * The progress page as the run's `levels` events left it. A later snapshot of the same kind
 * replaces the earlier one: the final read is repeated once when connect lags behind.
 */
export function levelsOf(events: readonly RunEvent[]): RunResult['levels'] {
  const levels: RunResult['levels'] = { initial: null, final: null };
  for (const e of events) if (e.type === 'levels') levels[e.kind] = e.snapshot;
  return levels;
}

/** One line per event for the log panel, in the same terms the CLI prints. */
export function eventText(e: RunEvent): string {
  switch (e.type) {
    case 'state':
      return copy.states[e.state];
    case 'topic':
      return `话题 ${e.topicId} · ${{ click: '点击', entered: '已进入', read: '已读', returned: '已返回' }[e.phase]}${e.result ? `（${e.result}）` : ''}`;
    case 'floor':
      return `楼层 ${e.from} → ${e.to}${e.confirmed ? '' : '（估算）'}`;
    case 'action':
      return `${e.action === 'like' ? '点赞' : '回复'} · ${{ attempted: '已尝试', confirmed: '已确认', rejected: '被拒绝' }[e.result]}`;
    case 'timings':
      return `已读回执：${e.postsReported} 层，${e.topicSeconds} 秒`;
    case 'stats':
      return `统计：确认 ${e.stats.confirmed.topics} 话题 / ${e.stats.confirmed.floors} 楼层`;
    case 'levels':
      return `${e.kind === 'initial' ? '初始' : '结束'}进度：${e.snapshot.metrics.map((m) => `${m.label} ${m.current}`).join('，')}`;
    case 'warning':
      return `${e.code}：${e.message}`;
    case 'error':
      return `${copy.errors[e.error.code] ?? e.error.code}：${e.error.message}`;
  }
}
