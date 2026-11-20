import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * KMTC codes each container move as its kind, its leg and its load: GTO gate out, GTI gate in,
 * LDG loading and DIS discharging; OB the export leg, TS transshipment, IB the import leg and ID
 * the empty container's moves between depots after its return; F full and E empty. "GTIIBE" is
 * an empty container gated in on the import leg.
 */
const MOVE_CODE = /^(GTO|GTI|LDG|DIS)(OB|TS|IB|ID)([FE])$/;

// The names KMTC's tracking page gives the steps of a container's trip.
const NAMED: Readonly<Record<string, string>> = {
  GTOOBE: 'Empty Container Pick Up',
  GTIOBF: 'Full Container Gate In',
  GTOOBF: 'Full Container Gate Out',
  LDGOBF: 'On Board',
  DISIBF: 'Discharging',
  GTIIBF: 'Full Container Arrival',
  GTOIBF: 'Full Container Pick Up',
  GTIIBE: 'Empty Container Return',
};
const MOVE: Readonly<Record<string, string>> = { GTO: 'Gate Out', GTI: 'Gate In', LDG: 'Loading', DIS: 'Discharging' };
const LEG: Readonly<Record<string, string>> = { OB: 'Export', TS: 'Transshipment', IB: 'Import', ID: 'Depot' };

/** What the event says: the page's name for the step, or the move, load and leg the code gives. */
export function kmtcWording(code: string): string {
  const named = NAMED[code];
  if (named) return named;
  const parts = MOVE_CODE.exec(code);
  return parts ? `${MOVE[parts[1]!]} ${parts[3] === 'F' ? 'Full' : 'Empty'} (${LEG[parts[2]!]})` : code;
}

/**
 * The stage of a move by its code. The shipper picks an empty container up and brings it back
 * full; it is moved and shipped full, and the consignee takes it full and returns it empty. An
 * empty container's other moves, such as its repositioning, are no step of the shipment.
 */
export function kmtcStage(code: string): Stage | undefined {
  const parts = MOVE_CODE.exec(code);
  if (!parts || parts[2] === 'ID') return undefined;
  const [, move, leg, load] = parts;
  if (load === 'E') return move === 'GTO' && leg === 'OB' ? 'registered' : move === 'GTI' && leg === 'IB' ? 'delivered' : undefined;
  if (move === 'GTI' && leg === 'OB') return 'accepted';
  if (move === 'GTO' && leg === 'IB') return 'out_for_delivery';
  return 'in_transit';
}

const BY_WORDING = new Map(Object.entries(NAMED).map(([code, wording]) => [normalizeStatusWording(wording), code]));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code) return kmtcStage(code);
    const named = BY_WORDING.get(normalizeStatusWording(wording));
    return named ? kmtcStage(named) : undefined;
  },
  gaps: [],
};
