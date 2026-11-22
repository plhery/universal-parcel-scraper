import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan types: `OUT-SCAN` when an office sends the air waybill on
 * to the next, `IN-SCAN` when the next one receives it. Both are legs inside
 * the network, the last one included: an inward scan at the destination hub is
 * not a delivery.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OUT-SCAN', 'in_transit'],
  ['IN-SCAN', 'in_transit'],
]);

/** The status line's, the delivery table's and the adapter's wordings. */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^BOOKED(?: BY\b|$)/i, 'accepted'],
  [/^OUT TO\b/i, 'in_transit'],
  [/^INWARD AT\b/i, 'in_transit'],
  [/^DELIVERED(?: ON\b|$)/i, 'delivered'],
];

/** The stage Mark Express's scan types, else its wordings, give a row. */
export function markMappedStage(code: string | null, wording: string): Stage | undefined {
  const coded = code ? CODES.get(code.toUpperCase()) : undefined;
  const text = wording.replace(/\s+/g, ' ').trim();
  return coded ?? WORDINGS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A row's stage: the carrier's own scan type or wording, else the shared wording rules, else nothing. */
export function markStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = markMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The review map: the scan types and wordings above, with no gaps. */
export const statusMap: CarrierStatusMap = { stage: (code, wording) => markMappedStage(code, wording), gaps: [] };
