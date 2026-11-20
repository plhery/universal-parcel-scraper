import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import evidence from './statuses.json' with { type: 'json' };

/** M24's parcel status ids, which every scan carries. */
const CODES: ReadonlyMap<string, Stage> = new Map(evidence.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** A scan's stage: its status id, else the shared wording rules, else nothing. */
export function m24Stage(code: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
