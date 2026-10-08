import type { ProgressModule } from './types';

/**
 * §5.1. The connect page labels are not fixed by the spec; they are filled in from the Phase 0
 * connect fixture. Until then every label maps to `other`, which is shown but never estimated.
 */
export const connectLinuxdo: ProgressModule = {
  source: 'connect-linuxdo',
  labelMap: {},
};
