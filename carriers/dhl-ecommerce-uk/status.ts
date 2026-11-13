/**
 * DHL eCommerce UK status vocabulary.
 *
 * The tracking page has no status codes. Each row of the journey is a sentence,
 * most of which name the shipment; `statuses.json` holds those sentences
 * without the number and the stage each one means. A sentence the list does not know keeps
 * its wording and gets no stage.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The page writes some apostrophes curly.
const key = (wording: string) => wording.toLowerCase().replace(/[’‘]/g, "'");
const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [key(entry.wording), entry.stage as Stage]));
// The row the page adds once it plans a delivery day, with that day, after the collection, and
// again for a delivery to a ServicePoint after a missed one.
const DUE = /^your shipment is due to be delivered (?:to your servicepoint )?on (?:mon|tues|wednes|thurs|fri|satur|sun)day \d{1,2}(?:st|nd|rd|th) [a-z]+ \d{4}$/;

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export function dhlEcommerceUkStage(wording: string): Stage | undefined {
  const text = key(wording);
  return WORDINGS.get(text) ?? (DUE.test(text) ? 'in_transit' : undefined);
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}

/**
 * What the map says about one scan: its sentence without the number, as the parser keeps it. A
 * provider's copy of the sentence still names the shipment, so a run of digits is taken out first.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => dhlEcommerceUkStage(wording.replace(/\d{7,}/g, ' ').replace(/\s+/g, ' ').trim()),
  gaps: [],
};
