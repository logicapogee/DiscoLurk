import type { MetricKey, ProgressSource, Site } from '@disco-lurk/core';
import { connectLinuxdo } from './connect-linuxdo';
import { trustLevelDocofcard } from './trust-level-docofcard';
import type { ProgressModule } from './types';

export type { ProgressModule } from './types';

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
