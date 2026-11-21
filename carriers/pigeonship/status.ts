import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order's status code. The tracking page shows "Delivered" for 64 and "In transit" for
 * every other code, cancelled ones included, so only the codes seen are staged.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // "Assigned": the order is on a driver's route.
  ['16', 'in_transit'],
  ['64', 'delivered'],
]);

export function pigeonshipStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code) : undefined),
  gaps: [],
};
