import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostRelayedStage } from '../china-post/status.js';
import { imileRelayedStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly english?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * JS Express's rows carry wording and a code: its own warehouse and flight
 * lines, then those of the partners that fly, clear and deliver the parcel, in
 * their words. The map is the wording recorded in `statuses.json`, by its
 * `normalizeStatusWording` form, and the English an entry shows for its
 * Chinese, then China Post's domestic scans and iMile's as JS Express relays
 * them, then the codes that settle a stage alone. The shared rules read a
 * destination agent's pickup at the airport, or a courier's receipt, as an
 * acceptance.
 */
const WORDINGS = statusWordings(ENTRIES.flatMap(({ wording, stage, english }) => stage ? [{ wording, stage, english }] : []));

/** A partner's record of the parcel's data, or a message to the recipient: no scan, so no stage. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

// USPS's forwarding alert as JS Express relays it, with the time, day and town it names: the parcel goes on to another
// address, as USPS's own map reads its "Forwarded".
const FORWARDED = /^alert, forwarded -> your item was forwarded to a different address\b/;

// USPS's status followed by its sentence, as JS Express relays it: "On the Way, Arrived at USPS Facility -> Your item
// arrived at our USPS facility in …". The sentence names the facility, day and time; the status before the arrow takes
// its own entry.
const USPS_SENTENCE = /^on the way, (.+?) -> your item\b/;
const uspsSentenceStage = (normalized: string): Stage | undefined => {
  const status = USPS_SENTENCE.exec(normalized)?.[1];
  return status ? WORDINGS.stage(status) : undefined;
};

// The destination courier's waybill with its reference after the wording ("Waybill Generated for …") takes the
// entry recorded without one.
const WAYBILL_REFERENCE = /^(waybill generated for) [a-z]{0,4}\d{6,30}$/;

// J&T Express Germany's scans as the destination courier open with the district in 【】 and name its sites in 【】,
// so each place makes a new wording: emptied of those names, they take their entry.
const BRACKETED = /【[^】]*】/g;
const bracketedStage = (normalized: string): Stage | undefined =>
  normalized.startsWith('【') ? WORDINGS.stage(normalized.replace(BRACKETED, '【】')) : undefined;

// iMile's scans as its destination courier, which open with the centre's name in 【】, take iMile's reading.
const mappedStage = (normalized: string): Stage | undefined =>
  WORDINGS.stage(normalized.replace(WAYBILL_REFERENCE, '$1')) ?? bracketedStage(normalized)
    ?? (FORWARDED.test(normalized) ? 'in_transit' : undefined)
    ?? uspsSentenceStage(normalized)
    ?? chinaPostRelayedStage(normalized)
    ?? imileRelayedStage(normalized);

/** The stage JS Express's map gives a row's wording. */
export function jsExpressMappedStage(wording: string): Stage | undefined {
  return mappedStage(normalizeStatusWording(wording));
}

/** The delivering depot's receipt, before each round and again after a missed delivery: a notice (see the parser). */
export const isJsExpressDepotReceipt = (wording: string): boolean => normalizeStatusWording(wording) === 'received at local depot';

/** The English shown for a row's wording in Chinese, or undefined. */
export const jsExpressEnglish = (wording: string): string | undefined => WORDINGS.english(normalizeStatusWording(wording));

/**
 * The stage of a row's code where the code settles it alone. Most rows are `OIT`, in transit, whatever
 * happened; others group the customs, the hand-overs and the courier's exceptions, forwards among them.
 */
const CODE_STAGES: ReadonlyMap<string, Stage> = new Map([
  ['OIR', 'registered'], ['OPU', 'accepted'], ['DIG', 'out_for_delivery'], ['DOD', 'ready_for_pickup'], ['DDF', 'failed_attempt'],
  ['DSD', 'delivered'],
]);

/**
 * A row's stage: the map, else its code, else the shared wording rules, else nothing. A recorded gap has none.
 */
export function jsExpressStage(wording: string, code: string | null = null): ClassifiedWording | null {
  if (GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const mapped = jsExpressMappedStage(wording) ?? (code ? CODE_STAGES.get(code) : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

const GAP_NOTES = new Map(GAPS.map((gap) => [gap.wording, gap.note]));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => GAP_WORDINGS.has(wording) ? undefined : mappedStage(wording) ?? (code ? CODE_STAGES.get(code) : undefined),
  gaps: GAPS,
  // A gap is one by its wording, whatever code the row carries.
  gapNote: (_code, wording) => GAP_NOTES.get(wording),
};
