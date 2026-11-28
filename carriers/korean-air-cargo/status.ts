import type { Stage } from '../../core/status/index.js';

/** The Cargo-IMP status codes Korean Air's tracker names in its script; the reply words each one itself. */
export const stages = new Map<string, Stage>([
  ['BKD', 'registered'],
  ['FOH', 'accepted'],
  ['RCS', 'accepted'],
  ['RCT', 'in_transit'],
  ['PRE', 'in_transit'],
  ['MAN', 'in_transit'],
  ['DEP', 'in_transit'],
  ['ARR', 'in_transit'],
  ['RCF', 'in_transit'],
  ['TFD', 'in_transit'],
  ['NFD', 'ready_for_pickup'],
  ['AWD', 'ready_for_pickup'],
  ['DLV', 'delivered'],
]);
