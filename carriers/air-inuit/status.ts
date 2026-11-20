import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Air Inuit's cargo system numbers each history line with its kind, `statuID`, and words it with
 * the flight or the station: "Accepted by Air Inuit Cargo in Schefferville (YKL)."
 */
const STAGES: Readonly<Record<string, Stage>> = {
  9: 'accepted',
  // Booked on a flight, then flown.
  2: 'in_transit',
  3: 'in_transit',
  // Received at the destination's cargo office, where the consignee collects it. A shipment
  // received at another station is in transit; the parser reads that from the reply.
  1: 'ready_for_pickup',
  4: 'delivered',
};

export function airInuitStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES[code];
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => airInuitStage(code),
  gaps: [],
};
