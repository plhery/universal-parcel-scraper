import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['Label created', 'registered'],
  ['Received at authorized shipping outlet', 'accepted'],
  ['In transit', 'in_transit'],
  ['Arrived at facility', 'in_transit'],
  ['Departed from facility', 'in_transit'],
  ['Processing at origin facility', 'in_transit'],
  ['On delivery route to origin warehouse', 'in_transit'],
  ['Delivered to origin warehouse', 'in_transit'],
  ['Received at origin warehouse', 'in_transit'],
  ['Added to container', 'in_transit'],
  ['Loaded into ocean container', 'in_transit'],
  ['Shipped from origin warehouse', 'in_transit'],
  ['In transit to destination country', 'in_transit'],
  ['Arrived at EU distribution center', 'in_transit'],
  ['Transferred to final-mile carrier', 'in_transit'],
  ['Customs cleared; preparing for loading', 'in_transit'],
  ['Handed over to final-mile carrier', 'in_transit'],
  ['Arrived at parcel center', 'in_transit'],
  ['Out for delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(normalizeStatusWording(wording)),
  gaps: [
    { wording: 'final-mile information received', note: 'Pre-advice for the delivery leg does not end existing custody.' },
    { wording: 'delivery expected today', note: 'An expectation alone does not establish a delivery round.' },
    { wording: 'tracking update', note: 'An unfamiliar or ambiguous update establishes no new stage.' },
  ],
};
