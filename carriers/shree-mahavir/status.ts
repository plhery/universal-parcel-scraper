import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';

/**
 * The tracker's job codes: `OUT` when an office sends the consignment on to
 * the next, `IN` when the next one receives it. Both are legs inside the
 * network, the last one included: an inward scan at the destination office is
 * not a delivery.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OUT', 'in_transit'],
  ['IN', 'in_transit'],
]);

/**
 * The status line's and the adapter's wordings, and the delivery statuses
 * archived lookups show. A return to origin is an exception until a return is
 * delivered.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^BOOKED(?: BY\b|$)/i, 'accepted'],
  [/^OUT TO\b/i, 'in_transit'],
  [/^INWARD AT\b/i, 'in_transit'],
  [/^DELIVERY ATTEMPTED BY\b.*\bBUT NOT SUCCEED/i, 'failed_attempt'],
  [/^RETURN TO ORIGIN$/i, 'exception'],
];

/** The stage Shree Mahavir's job codes, else its wordings, give a scan. */
export function mahavirMappedStage(code: string | null, wording: string): Stage | undefined {
  const coded = code ? CODES.get(code.toUpperCase()) : undefined;
  const text = wording.replace(/\s+/g, ' ').trim();
  return coded ?? WORDINGS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A scan's stage: the carrier's own code or wording, else the shared wording rules, else nothing. */
export function mahavirStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = mahavirMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
