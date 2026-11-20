import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import entries from './statuses.json' with { type: 'json' };

// The tracker's scan codes: posting, the post offices' departures and arrivals, the trucks'
// departures and arrivals, the hand-over to the postman, and delivery.
const CODES = new Map<string, Stage>([
  ['KT1', 'accepted'], ['KT2', 'in_transit'], ['KT3', 'in_transit'], ['VC3', 'in_transit'], ['VC4', 'in_transit'],
  ['KT12', 'out_for_delivery'], ['KT5', 'delivered'],
]);
const ROUTED = 'KT18';
const ROUTED_NOTE = 'The delivery office routes the item in the second it hands it to the postman; the scan keeps the stage before it.';
const WORDING = new Map(entries.entries.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// A scan's UPU event code, as in "EMI - Phát thành công (Delivered)".
const EVENT_CODE = /^[A-Z]{3} - /;

function wordingStage(wording: string): Stage | undefined {
  return WORDING.get(wording) ?? WORDING.get(wording.replace(/^[a-z]{3} - /, ''));
}

/** The stage of one scan by its code, else by its wording; none for the routing that comes with the hand-over. */
export function vnpostStage(code: string, description: string): ClassifiedWording | null {
  if (code === ROUTED) return null;
  const stage = CODES.get(code) ?? wordingStage(normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(description.replace(EVENT_CODE, ''), 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === ROUTED ? undefined : (code ? CODES.get(code) : undefined) ?? wordingStage(wording),
  gaps: [{ code: ROUTED, note: ROUTED_NOTE }],
};
