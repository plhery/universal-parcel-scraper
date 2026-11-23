import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** What a last move's wording says: the place it names, and its stage when the wording settles one. */
export interface SeaboardReading {
  place?: string;
  stage?: Stage;
}

// The page words a move as what happened to the container, its direction and what it carries, as
// "Equipment At Puerto Limon, Costa Rica Moving Import Empty." or
// "Equipment Dispatched To Customer Moving No Direction Empty.", and a vessel move as
// "Equipment On-Board Seaboard Viking V. 22 Full.".
const MOVING = /^Equipment (.+?) Moving (Import|Export|No Direction) (Full|Empty)\.$/i;
const AT = /^At (.+)$/i;
const ON_BOARD = /^Equipment On-Board .+ V\. ?\S+ (Full|Empty)\.$/i;

/**
 * A full container at a place on its way in or out, or on board, is in transit. Other moves are
 * left without a stage: the page shows only the last move, and an empty container's move or a
 * hand-over to a customer does not settle the shipment's step.
 */
export function seaboardMove(wording: string): SeaboardReading | undefined {
  const text = wording.replace(/\s+/g, ' ').trim();
  const moving = MOVING.exec(text);
  if (moving) {
    const place = AT.exec(moving[1]!)?.[1];
    const inTransit = place && moving[2]!.toLowerCase() !== 'no direction' && moving[3]!.toLowerCase() === 'full';
    return { ...(place ? { place } : {}), ...(inTransit ? { stage: 'in_transit' as const } : {}) };
  }
  const onBoard = ON_BOARD.exec(text);
  if (onBoard) return onBoard[1]!.toLowerCase() === 'full' ? { stage: 'in_transit' } : {};
  return undefined;
}

/** The stage of a move by its wording alone. */
export function seaboardStage(wording: string): Stage | undefined {
  return seaboardMove(wording)?.stage;
}

const UNSETTLED = 'An empty container\'s move or a hand-over to a customer, the only move the page shows, does not settle the shipment\'s step.';

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => seaboardStage(wording),
  gaps: [],
  gapNote: (_code, wording) => {
    const reading = seaboardMove(wording);
    return reading && !reading.stage ? UNSETTLED : undefined;
  },
};
