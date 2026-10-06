/**
 * DHL eCommerce UK status vocabulary.
 *
 * The tracking page has no status codes. Each row of the journey is a sentence
 * that names the shipment; `statuses.json` holds those sentences without the
 * number and the stage each one means. A sentence the list does not know keeps
 * its wording and gets no stage.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [entry.wording.toLowerCase(), entry.stage as Stage]));

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export function dhlEcommerceUkStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording.toLowerCase());
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}
