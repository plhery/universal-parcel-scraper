import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export interface SkladusaStatus {
  description: string;
  stage?: Stage;
  lastMile?: boolean;
  delivery?: boolean;
  partial?: boolean;
}

const key = (value: string): string => value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
const LABELS: ReadonlyMap<string, SkladusaStatus> = new Map([
  ['waybill has been created', { description: 'Waybill created', stage: 'registered' }],
  ['waybill created', { description: 'Waybill created', stage: 'registered' }],
  ['parcel is ready to depart the kyiv facility', { description: 'Preparing to depart origin facility', stage: 'registered' }],
  ['preparing to depart origin facility', { description: 'Preparing to depart origin facility', stage: 'registered' }],
  ['arrived at facility', { description: 'Arrived at facility', stage: 'in_transit' }],
  ['departed from facility', { description: 'Departed from facility', stage: 'in_transit' }],
  ['processing at ups facility', { description: 'Processing at carrier facility', stage: 'in_transit' }],
  ['processing at carrier facility', { description: 'Processing at carrier facility', stage: 'in_transit' }],
  ['loaded on delivery vehicle', { description: 'Loaded on delivery vehicle', stage: 'out_for_delivery', lastMile: true }],
  ['out for delivery today', { description: 'Out for delivery', stage: 'out_for_delivery', lastMile: true }],
  ['out for delivery', { description: 'Out for delivery', stage: 'out_for_delivery', lastMile: true }],
  ['delivered', { description: 'Delivered', stage: 'delivered', delivery: true }],
  ['in transit', { description: 'In transit', stage: 'in_transit' }],
]);

/** Fixed logistics wording only; place tails and arbitrary recipient prose never leave the parser. */
export function projectSkladusaStatus(wording: string): SkladusaStatus {
  const text = key(wording), known = LABELS.get(text);
  if (known) return known;
  if (!/@|https?:|\b(?:recipient|receiver|consignee|signature|signed|phone|contact|pin|pod)\b/i.test(text)) {
    if (/^in transit [a-z0-9 .,'()-]{1,160}$/.test(text)
      || /^parcel is in transit to poland for [a-z -]{1,60} export$/.test(text)) {
      return { description: 'In transit', stage: 'in_transit', partial: true };
    }
    if (/^arrived at [a-z0-9 .,'()-]{1,160}$/.test(text)) {
      return { description: 'Arrived at facility', stage: 'in_transit', partial: true };
    }
  }
  return { description: 'Tracking update', partial: true };
}

export function skladusaStage(code: string | null, wording: string): Stage | undefined {
  return code ? undefined : projectSkladusaStatus(wording).stage;
}

export const statusMap: CarrierStatusMap = {
  stage: skladusaStage,
  gaps: [{ wording: 'tracking update', note: 'Unmapped wording or a delivery label without terminal last-mile evidence.' }],
};
