import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * The page's rows and its status tag carry wording without codes. The map is the wording recorded
 * in `statuses.json`, then the patterns below for the sentences that name a facility and its town.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // The shipment is booked at a station, then the station takes it in.
  [/^shipment created .{1,160}$/, 'registered'],
  [/^shipment received at .{1,160}$/, 'accepted'],
  // Moves between stations, distribution centres and stores.
  [/^order has left .{1,160} to .{1,160}$/, 'in_transit'],
  [/^order has arrived at .{1,160}$/, 'in_transit'],
];

const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

/** The stage Konga Logistics's map gives a row's wording. */
export function kongaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return BY_WORDING.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. A recorded gap has none. */
export function kongaStage(wording: string): ClassifiedWording | null {
  if (GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const mapped = kongaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : kongaMappedStage(wording)),
  gaps: GAPS,
};
