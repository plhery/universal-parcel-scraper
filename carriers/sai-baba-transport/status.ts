import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['TRANSIT', 'in_transit'],
  ['OUT', 'in_transit'],
  ['IN', 'in_transit'],
  ['DELIVERY', 'delivered'],
]);

export function scanStage(code: string): Stage | undefined {
  return stages.get(code);
}

export function summaryStage(wording: string): Stage | undefined {
  return /^DELIVERED BY \S/i.test(wording) ? 'delivered' : undefined;
}
