import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A state of the tracker: its English wording on the public page, and its stage when it has one. */
interface LionStatus {
  readonly en: string;
  readonly stage?: Stage;
}

// The groups the tracking page files a number under, in its English. "Pre-alert" (预警 in Chinese)
// can be an advance notice or a warning, so it sets no stage of its own; a parcel that is not
// found has none either.
const GROUPS: ReadonlyMap<string, LionStatus> = new Map<string, LionStatus>([
  ['NOT_FOUNT', { en: 'No information available.' }],
  ['PRECESSING', { en: 'Processing', stage: 'registered' }],
  ['WARNING', { en: 'Pre-alert' }],
  ['IN_TRANSIT', { en: 'In transit.', stage: 'in_transit' }],
  ['RETURNED_BACK', { en: 'Returned', stage: 'returned' }],
  ['DELIVERED', { en: 'Delivered', stage: 'delivered' }],
]);

// The steps of the page's route rail, which a scan names as its icon. Dispatch covers the last mile
// up to the delivery, so it says no more than in transit.
const RAIL: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['HUB', 'accepted'],
  ['TRANSPORT', 'in_transit'],
  ['AIRPORT', 'in_transit'],
  ['CUSTOMS', 'customs'],
  ['DISPATCH', 'in_transit'],
  ['DELIVERED', 'delivered'],
]);

// The scan codes seen in replies, with 360Lion's English for each. `WSO` codes are scans at origin
// and `WSD` codes at destination.
const SCANS: ReadonlyMap<string, LionStatus> = new Map<string, LionStatus>([
  ['WSO04', { en: 'departed from airport', stage: 'in_transit' }],
  // The transit country's customs letting the parcel out, the day after the flight from China, and the
  // gateway's release to the destination country, an hour before the landing there.
  ['CD001', { en: 'Salida de Aduana', stage: 'in_transit' }],
  ['WSO111', { en: 'International Gateway released', stage: 'in_transit' }],
  ['WSD00', { en: 'arrived at airport', stage: 'in_transit' }],
  ['WSD02', { en: 'handover to lastmile', stage: 'in_transit' }],
  ['WSD051', { en: 'Arrived at sorting center', stage: 'in_transit' }],
  ['WSD050', { en: 'package on the way to delivery office', stage: 'in_transit' }],
]);

/** A group the page files a number under, by its code. */
export function lionGroup(code: string): LionStatus | undefined {
  return GROUPS.get(code);
}

/** A step of the page's route rail, by its name. */
export function lionRail(name: string): Stage | undefined {
  return RAIL.get(name);
}

/** A scan seen in replies, by its code. */
export function lionScan(code: string): LionStatus | undefined {
  return SCANS.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? (SCANS.get(code) ?? GROUPS.get(code))?.stage : undefined),
  gaps: [
    { code: 'WARNING', note: 'The page\'s "Pre-alert" group, 预警 in Chinese, which can be an advance notice or a warning: the scans decide the stage.' },
    { code: 'NOT_FOUNT', note: 'The group of a number the tracker does not know, which the adapter reports as not found.' },
  ],
};
