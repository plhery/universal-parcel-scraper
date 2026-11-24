import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's event codes, from the tracking page's script, with the stage each means. Code 6, a
// special event, and code 11, a last-mile carrier's scan, carry their meaning in their wording.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code !== undefined).map((entry) => [entry.code, entry.stage as Stage]));
// Wordings seen under those two codes, whole.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code === undefined).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The tracking page's English title for each event code, which stands in for an event without wording. */
export const CARGOMINI_EVENT_TITLES: ReadonlyMap<string, string> = new Map([
  ...statuses.entries.filter((entry) => entry.code !== undefined).map((entry) => [entry.code, entry.wording] as const),
  ['6', 'Special event'],
  ['11', 'Package is on the way to the customer'],
]);

function mapped(code: string | null, wording: string): Stage | undefined {
  return (code === null ? undefined : CODED.get(code)) ?? WORDED.get(normalizeStatusWording(wording));
}

/**
 * An event's stage by its code, else by its whole wording, else by the shared rules, with a
 * last-mile scan in transit when they find nothing.
 */
export function cargominiEventStage(code: string, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  return code === '11' ? { stage: 'in_transit', source: 'carrier_map' } : null;
}

/** Events are staged by the tracker's code; special events and last-mile scans by their whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
