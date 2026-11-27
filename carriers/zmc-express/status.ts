import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const BY_CODE: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ code, stage }) => [code, stage as Stage]));
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

/**
 * A status's wording without the detail ZMC Express writes after it: the warehouse, flight, trip
 * or country after " => ", the warehouse or reason after " | ".
 */
export function zmcWording(status: string): string {
  return status.split(/\s*(?:=>|\|)/, 1)[0]!.trim();
}

/** The stage ZMC Express's map gives a status code, else its wording. */
export function zmcMappedStage(code: string | null, status: string): Stage | undefined {
  return (code ? BY_CODE.get(code) : undefined) ?? BY_WORDING.get(normalizeStatusWording(zmcWording(status)));
}

/** A row's stage: the map by its code, else the shared wording rules, else nothing. */
export function zmcStage(code: string, status: string): ClassifiedWording | null {
  const mapped = zmcMappedStage(code, status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(zmcWording(status), 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// A wording that comes without its code, as a universal provider relays it, is read whole, up to its detail.
export const statusMap: CarrierStatusMap = { stage: (code, wording) => zmcMappedStage(code, wording), gaps: [], wholeWording: true };
