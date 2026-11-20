import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['rr_registered', 'registered'],
  ['rr_loaded_to_container', 'in_transit'],
  ['rr_in_transit', 'in_transit'],
  ['rr_arrived_at_port', 'in_transit'],
  ['rr_under_customs', 'customs'],
  ['rr_delivered', 'delivered'],
]);

export const adminStates = new Set(['rr_documents_verified']);
