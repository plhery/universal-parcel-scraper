import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import evidence from './statuses.json' with { type: 'json' };

/** Xindus's status codes, which every shipment, box and scan carries. */
const CODES: ReadonlyMap<string, Stage> = new Map(evidence.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** The stage Xindus's codes give a status code. */
export function xindusMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function xindusStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = xindusMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
