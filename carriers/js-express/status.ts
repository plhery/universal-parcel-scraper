import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostDestinationStage, chinaPostRelayedStage } from '../china-post/status.js';
import { imileRelayedStage } from '../imile/status.js';
import { phlpostRelayedStage } from '../phlpost/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly english?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * JS Express's rows carry wording and a code: its own warehouse and flight
 * lines, then those of the partners that fly, clear and deliver the parcel, in
 * their words. The map is the wording recorded in `statuses.json`, by its
 * `normalizeStatusWording` form, and the English an entry shows for its
 * Chinese, then China Post's scans, the posts' IPS scans and iMile's as JS
 * Express relays them, then the codes that settle a stage alone. The shared
 * rules read a destination agent's pickup at the airport, or a courier's
 * receipt, as an acceptance.
 */
const WORDINGS = statusWordings(ENTRIES.flatMap(({ wording, stage, english }) => stage ? [{ wording, stage, english }] : []));

/** A partner's record of the parcel's data, or a message to the recipient: no scan, so no stage. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));

// iMile's booking of a new delivery after a missed one, relayed without its centre and with the day booked:
// "NDR re-delivery audit confirmed,appointment date [2026-12-02]". Like iMile's "Shipment is scheduled to" line, it
// moves nothing.
const REDELIVERY_BOOKED = /^ndr re-delivery audit confirmed\s*,\s*appointment date \[\d{4}-\d{2}-\d{2}\]$/;
const REDELIVERY_NOTE = "iMile's booking of a new delivery day after a missed delivery: it moves nothing, so the stage before it stands.";
const GAP_NOTES: ReadonlyMap<string, string> = new Map(GAPS.map((gap) => [gap.wording, gap.note]));
const isGap = (normalized: string): boolean => GAP_NOTES.has(normalized) || REDELIVERY_BOOKED.test(normalized);

// USPS's forwarding alert as JS Express relays it, with the time, day and town it names: the parcel goes on to another
// address, as USPS's own map reads its "Forwarded".
const FORWARDED = /^alert, forwarded -> your item was forwarded to a different address\b/;

// USPS's status followed by its sentence, as JS Express relays it: "On the Way, Arrived at USPS Facility -> Your item
// arrived at our USPS facility in …", or "… -> Your package is moving within the USPS network …". The sentence names
// the facility, day and time; the status before the arrow takes its own entry.
const USPS_SENTENCE = /^on the way, (.+?) -> your (?:item|package)\b/;
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

// Its return to a hub after the parcel left it for the delivering depot names the hub in square brackets:
// "Ihre Sendung ist zu [Beispiel HUB] zurückgekehrt.".
const RETURNED_TO = /^(ihre sendung ist zu )\[[^\]]*\]( zurückgekehrt\.?)$/;

// JS Express's notice that the destination courier could not deliver the parcel and holds it until the recipient
// contacts it, with that courier's phone and email: "交货异常，投递失败，逾期退回或销毁的具体费用以账单为准，麻烦让收件人联系当地，
// 当地电话：…邮箱：…" ("delivery exception, delivery failed; the costs of a return or destruction past the deadline are as
// billed; please have the recipient contact the local courier"). The parcel waits on the recipient, not on another round.
const HELD_FOR_RECIPIENT = /^交货异常，投递失败，逾期退回或销毁/;

// The posts' IPS scans, which JS Express relays after the office's country in capitals: "CHINA Send item to customs",
// "PHILIPPINES Enroute to delivery office". China Post's posting there is its receipt of the parcel JS Express
// collected days before: on its way, not an acceptance.
const ipsStage = (normalized: string): Stage | undefined => {
  const stage = phlpostRelayedStage(normalized);
  return stage === 'accepted' ? 'in_transit' : stage;
};

// iMile's receipt at the airport of departure, relayed without its centre and with the flight it books: "Origin port
// warehouse receive，Flight Schedule ETD【HKG】…, ETA【AMS】…", in transit as iMile reads it.
const ORIGIN_PORT = /^origin port warehouse receive\s*[,，]\s*flight schedule etd\b/;

// iMile's scans as its destination courier, which open with the centre's name in 【】, take iMile's reading. China
// Post's labels for the destination leg, in Chinese, take its reading too.
const mappedStage = (normalized: string): Stage | undefined =>
  WORDINGS.stage(normalized.replace(WAYBILL_REFERENCE, '$1').replace(RETURNED_TO, '$1[]$2')) ?? bracketedStage(normalized)
    ?? (ORIGIN_PORT.test(normalized) ? 'in_transit' : undefined)
    ?? (FORWARDED.test(normalized) ? 'in_transit' : undefined)
    ?? (HELD_FOR_RECIPIENT.test(normalized) ? 'exception' : undefined)
    ?? uspsSentenceStage(normalized)
    ?? chinaPostRelayedStage(normalized)
    ?? chinaPostDestinationStage(normalized)
    ?? ipsStage(normalized)
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
 * One of its rows as a universal provider relays it under JS Express's name: the stage the map gives, `pending` for
 * a recorded gap, and the English shown for its Chinese. A wording the map lacks has no entry.
 */
export function jsExpressRelayedScan(label: string): { stage: Stage; wording: string } | undefined {
  const normalized = normalizeStatusWording(label);
  const wording = jsExpressEnglish(label) ?? label;
  if (isGap(normalized)) return { stage: 'pending', wording };
  const stage = mappedStage(normalized);
  return stage && { stage, wording };
}

/**
 * The stage of a row's code where the code settles it alone. Most rows are `OIT`, in transit, whatever
 * happened; others group the customs, the hand-overs and the courier's exceptions, forwards among them.
 */
const CODE_STAGES: ReadonlyMap<string, Stage> = new Map([
  ['OIR', 'registered'], ['OPU', 'accepted'], ['DIG', 'out_for_delivery'], ['DOD', 'ready_for_pickup'], ['DDF', 'failed_attempt'],
  ['DSD', 'delivered'],
]);

// A bare collection or receipt names neither who took the parcel nor where. Under `OIT`, JS Express's code for a parcel
// on its way, it is a line's agent taking the parcel on a day after its departure from origin; under a code that
// settles the stage alone, such as a delivery's, the code reads it, as a recipient's collection at a pickup point.
const BARE_IN_TRANSIT = new Set(['collected', 'received']);
const codeStage = (code: string | null, normalized: string): Stage | undefined => !code ? undefined
  : CODE_STAGES.get(code) ?? (code === 'OIT' && BARE_IN_TRANSIT.has(normalized) ? 'in_transit' : undefined);

/**
 * A row's stage: the map, else its code, else the shared wording rules, else nothing. A recorded gap has none.
 */
export function jsExpressStage(wording: string, code: string | null = null): ClassifiedWording | null {
  if (isGap(normalizeStatusWording(wording))) return null;
  const mapped = jsExpressMappedStage(wording) ?? codeStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => isGap(wording) ? undefined : mappedStage(wording) ?? codeStage(code, wording),
  gaps: GAPS,
  // A gap is one by its wording, whatever code the row carries.
  gapNote: (_code, wording) => GAP_NOTES.get(wording) ?? (REDELIVERY_BOOKED.test(wording) ? REDELIVERY_NOTE : undefined),
};
