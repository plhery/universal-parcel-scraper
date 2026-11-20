import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestones the adapter reads from an order's record, each with the code it
 * keeps: the record's own field or stop type. The record dates them but gives no
 * wording, so the labels follow the portal's status line.
 */
export const PHANTOM_LABELS = {
  created: { code: 'CREATED', description: 'Order created', stage: 'registered' },
  assigned: { code: 'ASSIGNED', description: 'Assigned to a driver', stage: 'registered' },
  picked_up: { code: 'PICK_UP', description: 'Picked up', stage: 'accepted' },
  delivered: { code: 'DROP_OFF', description: 'Delivered', stage: 'delivered' },
  attempted: { code: 'DROP_OFF', description: 'Delivery attempted', stage: 'failed_attempt' },
  returned: { code: 'RETURN', description: 'Returned', stage: 'returned' },
} as const satisfies Record<string, { code: string; description: string; stage: Stage }>;

const LABELLED: ReadonlyMap<string, Stage> = new Map(Object.values(PHANTOM_LABELS)
  .map((label) => [`${label.code}\n${label.description.toLowerCase()}`, label.stage]));

/**
 * The stage and wording of the order's status, as the portal's status line words it:
 * an order waits until its driver picks it up, a completed one is delivered unless
 * the drop-off was only attempted, and a failed or deleted one is no longer active.
 * A hold outranks the rest until the order is closed. A status the portal does not
 * name, such as a paused order, gets none.
 */
export function phantomShipmentStage(status: string, completionReason: string, holdStatus: string): { stage: Stage; text: string } | null {
  if (status === 'COMPLETED') {
    return completionReason === 'ATTEMPTED' ? { stage: 'failed_attempt', text: 'Attempted' } : { stage: 'delivered', text: 'Delivered' };
  }
  if (status === 'FAILED' || status === 'DELETED') return { stage: 'exception', text: 'This Order is No Longer Active' };
  if (holdStatus === 'ON_HOLD') return { stage: 'exception', text: 'Your order is on hold.' };
  if (status === 'CREATED' || status === 'ASSIGNED' || status === 'ROUTED') return { stage: 'registered', text: 'Pending' };
  if (status === 'IN_TRANSIT') return { stage: 'in_transit', text: 'In Transit' };
  return null;
}

/** The adapter's milestones carry their code; any other scan is not Phantom's. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? LABELLED.get(`${code}\n${wording}`) : undefined),
  gaps: [],
};
