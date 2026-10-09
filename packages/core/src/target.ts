import type { RunStats } from './events';
import type { BrowseMode, RunMode } from './terms';

/** Quick mode counts entered topics only; deep mode counts topics plus confirmed floors. */
function countedProgress(stats: RunStats, browseMode: BrowseMode): number {
  return browseMode === 'quick' ? stats.confirmed.topics : stats.confirmed.topics + stats.confirmed.floors;
}

/** Whether the run mode's target is met. `stats.elapsedMs` comes from the monotonic clock, so wall-clock jumps cannot end a time run early. */
export function targetReached(runMode: RunMode, browseMode: BrowseMode, stats: RunStats): boolean {
  switch (runMode.kind) {
    case 'endless':
      return false;
    case 'topics':
      return countedProgress(stats, browseMode) >= runMode.count;
    case 'time':
      return stats.elapsedMs >= runMode.minutes * 60_000;
  }
}
