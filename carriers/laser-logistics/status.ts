import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The event codes Laser Logistics's tracker gives each scan. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['WBLCRE', 'registered'], // Waybill Created.
  ['WBLALL', 'in_transit'], // In Transit, on the line haul between hubs.
  ['WBLDAL', 'in_transit'], // On Floor: at the delivering hub.
  ['WBLALD', 'out_for_delivery'], // In Trip: loaded on the delivery trip, hours before the proof of delivery.
  ['PODCRE', 'delivered'], // POD: the proof of delivery is captured.
  ['WBLDEB', 'delivered'], // The driver's delivery sheet confirms the delivery.
  ['WBLDLV', 'delivered'], // Delivered.
]);

/** The same events by the wording the page's table shows without their codes. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['waybill created', 'registered'],
  ['in transit', 'in_transit'],
  ['on floor', 'in_transit'],
  ['in trip', 'out_for_delivery'],
  ['pod', 'delivered'],
  ['proof of delivery', 'delivered'],
  ['delivered', 'delivered'],
]);

// WBLDEB's wording names the waybill and the delivery sheet: "Waybill {number} Confirmed delivery by driver off delivery sheet {sheet}".
const DRIVER_CONFIRMED = /^waybill [a-z0-9]+ confirmed delivery by driver off delivery sheet\b/;

/** The stage the map gives an event code, or a wording when there is no code. */
export function laserMappedStage(code: string, wording: string): Stage | undefined {
  if (code.trim()) return CODES.get(code.trim().toUpperCase());
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (DRIVER_CONFIRMED.test(key) ? 'delivered' : undefined);
}

/** A scan's stage: its code or wording from the map, else the shared wording rules, else nothing. */
export function laserStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = laserMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => laserMappedStage(code ?? '', wording),
  gaps: [],
  wholeWording: true,
};
