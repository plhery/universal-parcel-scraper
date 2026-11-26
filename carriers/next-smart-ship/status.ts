import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** One of the tracker's statuses for a shipment: its label on the page and its stage. */
interface NextSmartShipSummary {
  readonly wording: string;
  readonly stage: Stage;
}

/**
 * `track_detail.status`, with the label the tracker gives it. In Transit runs from the label to
 * the last mile's delivery round, so the newest scan says more within it.
 */
const SUMMARIES: ReadonlyMap<string, NextSmartShipSummary> = new Map([
  ['TRACK_STATUS_RECEIVED', { wording: 'Info Received', stage: 'registered' }],
  ['TRACK_STATUS_IN_TRANSIT', { wording: 'In Transit', stage: 'in_transit' }],
  ['TRACK_STATUS_DELIVERED', { wording: 'Delivered', stage: 'delivered' }],
  ['TRACK_STATUS_EXCEPTION', { wording: 'Abnormal', stage: 'exception' }],
]);

export const EXCEPTION_STATUS = 'TRACK_STATUS_EXCEPTION';

export function nextSmartShipSummary(code: string): NextSmartShipSummary | undefined {
  return SUMMARIES.get(code);
}

// The stages an In Transit shipment's newest scan can give it: the last mile's own steps.
const LAST_MILE: ReadonlySet<Stage> = new Set(['customs', 'out_for_delivery', 'ready_for_pickup', 'failed_attempt', 'returned', 'exception']);

/** The shipment's stage: its status, its newest scan's within In Transit, or the scan's without a status. */
export function nextSmartShipCurrentStage(summary: NextSmartShipSummary | undefined, scanned: Stage | undefined): Stage | undefined {
  if (!summary) return scanned;
  if (summary.stage === 'in_transit' && scanned && LAST_MILE.has(scanned)) return scanned;
  return summary.stage;
}

/**
 * Next Smart Ship's own lines that the shared rules read otherwise. The rest is the line's and
 * the last-mile carrier's wording, relayed as each words it.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The warehouse has the order and is picking it; nothing has left yet.
  ['order is being processed', 'registered'],
  // The parcel left the warehouse with the line.
  ['order is shipped out.', 'accepted'],
  // The export declaration, filed before the line-haul leaves China: nothing waits on customs.
  ['customs declaration completed', 'in_transit'],
  // The last mile taking the parcel over, days after the warehouse shipped it.
  ['accepted at usps facility', 'in_transit'],
  ['accepted by driver for transfer', 'in_transit'],
]);

export function nextSmartShipMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function nextSmartShipStage(wording: string): ClassifiedWording | null {
  const mapped = nextSmartShipMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans carry no code; a status is the provider code of a shipment without scans. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? nextSmartShipMappedStage(wording) : SUMMARIES.get(code)?.stage),
  gaps: [],
};
