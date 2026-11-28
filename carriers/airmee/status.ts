import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Airmee's tracker gives each row a courier status code; its page words the row by that code, the row's leg
 * (out to the recipient or back to the sender), its reason and its service. statuses.json lists each code with
 * each label the page gives it and the label's stage.
 */
const ENTRIES = statuses.entries as readonly { code: string; wording: string; stage?: Stage }[];
const key = (code: string, wording: string) => `${code}\n${normalizeStatusWording(wording)}`;
const CODED: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => (entry.stage ? [[key(entry.code, entry.wording), entry.stage]] : [])));
// Every label has one stage whatever its code, so a label that comes without its code is read alone.
const WORDED: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => (entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage]] : [])));

/** What the page reads of one row besides its code. */
export interface AirmeeRow {
  /** On the leg back to the sender. */
  returnLeg: boolean;
  /** The row's reason, with underscores as spaces, or empty. */
  reason: string;
  /** A parcel locker service. */
  locker: boolean;
}

/** What the page reads of the whole shipment to word some rows. */
export interface AirmeeShipment {
  /** Booked or turned into a return (`order_metadata`). */
  returnOrder: boolean;
  /** The return is on its way back, by the page's own test on the shipment's status and its bookings. */
  movingReturn: boolean;
}

/**
 * The label Airmee's tracking page gives a row, as its script words it. Where the page shows the bare code, a
 * move back to the sender is worded as the page words the others and a courier on the way to collect as on the
 * return leg; a code the page does not know keeps the code.
 */
export function airmeeLabel(code: string, row: AirmeeRow, shipment: AirmeeShipment): string {
  const { returnLeg, reason } = row;
  switch (code) {
    case 'UNASSIGNED':
    case 'WAITING':
      if (!returnLeg) return 'Shipment Booked';
      if (reason.includes('postponements') || reason.includes('Due date passed')) return 'Return in progress';
      return reason.includes('damaged') ? 'Return Initiated Due to Packaging Issue' : 'Pickup Booked';
    case 'POSTPONED_OTHER':
      if (returnLeg) return 'In Return Transit';
      return reason.toLowerCase() === 'did not arrive at the warehouse' ? 'Awaiting Handover' : 'Delivery Delayed';
    case 'SCAN':
      if (!returnLeg) return 'In Transit';
      return shipment.movingReturn ? 'In Return Transit' : 'Label printed';
    case 'PICKUP_CONFIRMED':
      if (!returnLeg) return 'Out for Delivery';
      return row.locker ? 'In Return Transit' : 'Return Collected';
    case 'ON_WAY_TO_DROPOFF':
      return returnLeg ? 'In Return Transit' : 'Delivery in progress';
    case 'ON_WAY_TO_PICKUP':
      return 'Pickup in Progress';
    case 'DROPOFF_CONFIRMED':
      return returnLeg ? 'Returned' : 'Delivered';
    case 'POSTPONED_UNREACHABLE_CUSTOMER':
      return returnLeg ? 'Pickup Attempt Failed' : 'Delivery Attempt Failed';
    case 'POSTPONED_ATTEMPT':
      return returnLeg ? 'Pickup Delayed' : 'Delivery Delayed';
    case 'CANCELLED':
      return 'Delivery Cancelled';
    case 'READY_FOR_CUSTOMER_PICKUP':
      return 'Ready for Pickup';
    case 'EDIT':
      if (returnLeg) return reason === 'requested by customer' ? 'Return Date Updated by Customer' : 'Return Date Updated by Retailer';
      if (reason === 'Parcel marked as damaged' && !shipment.returnOrder) return 'Packaging Issue Reported';
      return reason === 'requested by customer' ? 'Delivery Date Updated by Customer' : 'Delivery Date Updated by Retailer';
    default:
      return code;
  }
}

/** The stage of a row by its code and the page's label for it. */
export const airmeeStage = (code: string, label: string): Stage | undefined => CODED.get(key(code, label));

const EDIT_NOTE = 'A change of the booked delivery or return date, or damaged packaging reported while the delivery goes on: '
  + 'not a move, so the parcel keeps its stage.';

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODED.get(key(code, wording)) : WORDED.get(wording)),
  gaps: [{ code: 'EDIT', note: EDIT_NOTE }],
  wholeWording: true,
};
