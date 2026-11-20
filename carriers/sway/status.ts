import type { Stage } from '../../core/status/index.js';

const states = new Map<string, Stage>([
  ['PENDING', 'registered'],
  ['RECEIVED', 'accepted'],
  ['DEPARTED', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['ARRIVING', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['FAILED', 'exception'],
  ['RETURNING_TO_SENDER', 'in_transit'],
  ['RETURNED_TO_SENDER', 'returned'],
  ['CANCELED', 'exception'],
]);

export function stageForScan(code: string): Stage | undefined {
  return states.get(code);
}
