import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order's status code. The tracking page shows "Delivered" for 64 and "In transit" for
 * every other code, cancelled ones included, so only the codes seen are staged.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // "Assigned": the order is on a driver's route.
  ['16', 'in_transit'],
  ['64', 'delivered'],
]);

/** The line of the page that replaces the tracking page once the delivery is complete. */
const COMPLETED = 'your delivery has been completed successfully.';

export function pigeonshipStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : normalizeStatusWording(wording) === COMPLETED ? 'delivered' : undefined),
  gaps: [],
};
