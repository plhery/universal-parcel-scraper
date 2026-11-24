import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The scan wordings the tracking frame was seen to give, whole, with the stage each means.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// Scans whose wording goes on with the vessel and voyage, or with the courier and its number.
const PREFIXED: readonly (readonly [RegExp, Stage])[] = [
  [/^sea vessel dispatched\b/, 'in_transit'],
  [/^sea arrived\b/, 'in_transit'],
  [/^shipment despatched to courier\b/, 'in_transit'],
];

function mapped(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDED.get(key) ?? PREFIXED.find(([pattern]) => pattern.test(key))?.[1];
}

/** A scan's stage from the map, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function tlaStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The frame gives no codes: a scan's wording sets its stage. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
};
