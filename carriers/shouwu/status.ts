import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { imileRelayedStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Shouwu's tracker gives a parcel's status as one of four codes
 * (`traceStatus`), which its page labels, and its scans as wording without
 * codes. A code's wording is the page's label for it, not a scan's; scan
 * wording recorded without a code is the map's, and the rest falls to the
 * shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const LABELS: ReadonlyMap<string, string> = new Map(ENTRIES.filter((entry) => entry.code && entry.wording)
  .map((entry) => [entry.code!, entry.wording!]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/**
 * Shouwu's own rows that name a batch or a flight's day: "1013C，申报过港中" for a batch declared
 * for the road to Hong Kong, and "预计23号的航班", or "二程预计27号的航班" for the second leg, for
 * the flight booked.
 */
const PATTERNS: readonly [RegExp, Stage][] = [
  [/^[a-z0-9]{1,12}[，,] ?申报过港中$/, 'in_transit'],
  [/^(?:二程)?预计\d{1,2}号的航班$/, 'in_transit'],
];

/**
 * A wording's stage in Shouwu's map, the wording in `normalizeStatusWording` form. On the line into
 * Italy the delivering partner is iMile, whose rows open with its centre in 【】 ("【Milan center】Received."):
 * iMile's sentences read them.
 */
function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1] ?? imileRelayedStage(wording);
}

/** The stage of a parcel's status code. */
export function shouwuStatusStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The page's label for a parcel's status code. */
export function shouwuStatusLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function shouwuStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a parcel's status, by its code, or about a scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : mappedStage(wording)),
  gaps: [],
};
