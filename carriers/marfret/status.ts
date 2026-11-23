import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The moves Marfret's tracker names, by their wording: a few words, as "Loaded OnBoard". */
export type MarfretMove = 'allocated' | 'depot gate out' | 'terminal gate in' | 'loaded onboard' | 'discharged' | 'terminal gate out' | 'depot gate in';

// The stage each move has in the usual cycle: the empty container is allocated to a booking and
// leaves the depot for the shipper, enters the terminal full, is loaded and discharged, leaves
// the terminal with the consignee and comes back empty to a depot.
const STAGES: Readonly<Record<MarfretMove, Stage>> = {
  allocated: 'registered',
  'depot gate out': 'registered',
  'terminal gate in': 'accepted',
  'loaded onboard': 'in_transit',
  discharged: 'in_transit',
  'terminal gate out': 'out_for_delivery',
  'depot gate in': 'delivered',
};

/** The move a wording names, or none for a wording the tracker has not shown. */
export function marfretMove(wording: string): MarfretMove | undefined {
  const text = normalizeStatusWording(wording);
  return Object.hasOwn(STAGES, text) ? text as MarfretMove : undefined;
}

/**
 * The stage of a move by its wording alone. The tracker uses the same few words at every port, so
 * the parser stages each move by where it falls in the container's cycle.
 */
export function marfretStage(wording: string): Stage | undefined {
  const move = marfretMove(wording);
  return move ? STAGES[move] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => marfretStage(wording),
  gaps: [],
};
