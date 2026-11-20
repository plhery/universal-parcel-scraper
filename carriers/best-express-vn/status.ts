import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// BEST's scan types: collection, dispatch to the next site, arrival at it, the delivery round
// and the signature.
const CODES = new Map<string, Stage>([
  ['01', 'accepted'], ['02', 'in_transit'], ['03', 'in_transit'], ['04', 'out_for_delivery'], ['17', 'delivered'],
]);
// Those scans' wordings once the place and the courier are taken out, in Vietnamese and in the
// English the Thai tracker is read in, and the order the history opens with. A signature names who
// signed before "Ký nhận" or "POD".
const WORDINGS: [RegExp, Stage][] = [
  [/^successfully ordered$/, 'registered'],
  [/^(?:đã thu thập|pickup)$/, 'accepted'],
  [/^(?:được gửi đến|đến nơi|on the way to|arrived) \S/, 'in_transit'],
  [/^(?:đang giao hàng|delivery on the way)$/, 'out_for_delivery'],
  [/^\S.* (?:ký nhận|pod)$/, 'delivered'],
];

function wordingStage(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** The stage of one scan by its type, else by its wording. */
export function bestStage(code: string, description: string): ClassifiedWording | null {
  const stage = CODES.get(code) ?? wordingStage(normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(description, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? wordingStage(wording),
  gaps: [],
};
