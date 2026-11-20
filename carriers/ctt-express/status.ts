import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The steps CTT Portugal takes on a parcel bound for Portugal: its rounds, a failed attempt, a pickup point's availability and the delivery. */
export const PORTUGAL_LEG: ReadonlySet<string> = new Set(['1500', '1600', '2100', '2310', '2900']);

const codes: Record<string, ClassifiedStatus> = {
  '0000': { status: 'pending', stage: 'registered' },
  '0500': { status: 'in_transit', stage: 'accepted' },
  '0600': { status: 'exception', stage: 'exception' },
  '1000': { status: 'in_transit', stage: 'in_transit' },
  // The international leg is still upstream: CTT Express has not received the parcel.
  '3900': { status: 'pending', stage: 'registered' },
  '1500': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  '1600': { status: 'exception', stage: 'exception' },
  // Held at the depot after a failed delivery, until a new round or a return.
  '1700': { status: 'exception', stage: 'exception' },
  // "Nuevo reparto": a new round planned, which the official widget groups with 1500. The parcel waits at the depot:
  // the round itself (1500) follows an hour or more later, after a failed attempt the next day.
  '2400': { status: 'in_transit', stage: 'in_transit' },
  '2310': { status: 'in_transit', stage: 'ready_for_pickup' },
  // "Recogerán en Delegación": the delivery failed and the recipient is to collect the parcel
  // from the delivery office. It comes at the delivery partner's failed attempt, before the
  // parcel is ready to collect.
  '2900': { status: 'exception', stage: 'failed_attempt' },
  // The widget explicitly says the parcel is on its way back to the sender.
  '2500': { status: 'exception', stage: 'exception' },
  '2700': { status: 'exception', stage: 'returned' },
  '2100': { status: 'delivered', stage: 'delivered' },
  '2110': { status: 'delivered', stage: 'delivered' },
};

export function classifyCttExpressStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/**
 * What the map says about one scan: its code, as the adapter reads it. After the turn back to
 * the sender (2500) the adapter reads a delivery as the return, which the code alone does not show.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? classifyCttExpressStatus(code)?.stage : undefined), gaps: [] };
