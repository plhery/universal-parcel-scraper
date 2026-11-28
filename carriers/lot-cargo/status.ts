import type { Stage } from '../../core/status/index.js';

/** LOT Cargo's message codes, which the tracker words alongside them. */
export const stages = new Map<string, Stage>([
  ['KK', 'registered'],
  ['NN', 'registered'],
  ['RCS', 'accepted'],
  ['PRE', 'in_transit'],
  ['MAN', 'in_transit'],
  ['DEP', 'in_transit'],
  ['ARR', 'in_transit'],
  ['RCF', 'in_transit'],
  ['NFD', 'ready_for_pickup'],
  ['AWD', 'ready_for_pickup'],
  ['DLV', 'delivered'],
]);

/** Codes a station reports on the flight's arrival, so at its destination airport. */
export const arrivalCodes = new Set(['ARR', 'RCF', 'NFD', 'AWD', 'DLV']);
