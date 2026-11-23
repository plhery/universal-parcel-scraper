import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event numbers SkyQuick's tracker tags each scan with: the GETOnline
 * network's numbers under SkyQuick's own wordings. Only numbers seen in
 * replies are mapped; another number falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'delivered'], // Successful Delivery.
  ['3', 'in_transit'], // Departed SkyQuick Facility.
  ['4', 'in_transit'], // Arrived SkyQuick Facility.
  ['14', 'in_transit'], // In Transit Delay: the history moved on after it.
  ['15', 'out_for_delivery'], // On Vehicle for Delivery.
  ['18', 'failed_attempt'], // Unsuccessful Delivery Attempt.
  ['53', 'failed_attempt'], // Unable to Complete Delivery - Unavoidable Delay, at the end of a round the parcel was on.
  ['262', 'in_transit'], // Scheduled for Delivery, at the delivering station.
]);

/** The stage SkyQuick's event numbers give a scan. */
export function skyquickMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

const GAPS: CarrierStatusMap['gaps'] = [
  { code: '45', note: 'Shipment Returned to SkyQuick Sending Facility, seen at the destination after a failed attempt and before the delivery: the parcel went back to the depot. The wording also fits a return to the origin, so it moves nothing.' },
  { code: '148', note: 'Info Message Sent to Recipient: a message to the recipient, which moves nothing.' },
];
const UNSTAGED = new Set(GAPS.map((gap) => gap.code));

/** A scan's stage: its event number, else the shared wording rules, else nothing. */
export function skyquickStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = skyquickMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? skyquickMappedStage(code) : undefined),
  gaps: GAPS,
};
