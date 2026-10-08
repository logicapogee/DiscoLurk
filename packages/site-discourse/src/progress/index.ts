import type { MetricKey, ProgressSource, Site } from '@disco-lurk/core';
import { connectLinuxdo } from './connect-linuxdo';
import { trustLevelDocofcard } from './trust-level-docofcard';
import type { ProgressModule } from './types';

export type { ProgressModule } from './types';

/** How long a progress page may take to render its metrics before the read gives up. */
export const PROGRESS_READY_MS = 20_000;
/** S07: the docofcard trust level table; its loader never leaves the DOM, so only rows count. */
export const TRUST_LEVEL_READY_MS = 10_000;

export const PROGRESS_MODULES: Readonly<Record<Exclude<ProgressSource, 'none'>, ProgressModule>> = {
  'connect-linuxdo': connectLinuxdo,
  'trust-level-docofcard': trustLevelDocofcard,
};

export const LABEL_MAP: Readonly<Record<Exclude<ProgressSource, 'none'>, Readonly<Record<string, MetricKey>>>> = {
  'connect-linuxdo': connectLinuxdo.labelMap,
  'trust-level-docofcard': trustLevelDocofcard.labelMap,
};

/** §6.1: the adapter picks the progress implementation from the site; the kernel never sees which. */
export function progressModuleFor(site: Pick<Site, 'progressSource'>): ProgressModule | null {
  return site.progressSource === 'none' ? null : PROGRESS_MODULES[site.progressSource];
}

export function mapLabel(module: ProgressModule, label: string): MetricKey {
  return module.labelMap[label.trim()] ?? 'other';
}
