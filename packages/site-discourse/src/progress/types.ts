import type { MetricKey, ProgressSource } from '@disco-lurk/core';

export interface ProgressModule {
  source: Exclude<ProgressSource, 'none'>;
  /** Page label → metric key, locked by the site's fixture (§5.2). Unknown labels map to `other`. */
  labelMap: Readonly<Record<string, MetricKey>>;
}
