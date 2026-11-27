import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { SUB_STAGES } from '../../providers/seventeentrack/status.js';
import { imileRelayedStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string | null }
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
// Some lines close the same wording with a full stop ("Hand over to airline."), others not ("Parcel departed from
// Facility"): the map compares scan wording without it.
const CLOSING_STOP = /(?<!\.)\.$/;
const unstopped = (wording: string): string => wording.replace(CLOSING_STOP, '');
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.wording && entry.stage)
  .map((entry) => [unstopped(normalizeStatusWording(entry.wording!)), entry.stage as Stage]));

/**
 * The flight booked for the parcel, before it flies: "Estimated time of take-off", "Scheduled flights", or
 * Shouwu's own "预计23号的航班", and "二程预计27号的航班" for the second leg, naming the flight's day. A
 * forecast, not a movement, so it keeps the stage of the scan before it.
 */
const FLIGHT_BOOKED = /^estimated time of take-off$|^scheduled flights$|^(?:二程)?预计\d{1,2}号的航班$/;

/** Whether a scan is the flight booked for the parcel, a notice on the stage of the scan before it. */
export const isShouwuFlightBooked = (wording: string): boolean => FLIGHT_BOOKED.test(normalizeStatusWording(wording));

/**
 * Rows whose wording carries a variable part: Shouwu's own that name a batch, "1013C，申报过港中"
 * for a batch declared for the road to Hong Kong, and the last mile's return with its reason.
 */
const PATTERNS: readonly [RegExp, Stage][] = [
  [/^[a-z0-9]{1,12}[，,] ?申报过港中$/, 'in_transit'],
  // The line repeats the milestone before a pipe and appends information about the same scan.
  [/^goods leaving the operation center \| (?:the outbound scan at the operation center is complete|the shipment has been loaded onto the transport vehicle)\.?$/, 'in_transit'],
  [/^shipment started the customs clearance process at origin \| export declaration data has been prepared\.?$/, 'in_transit'],
  [/^the shipment has been loaded onto the delivery vehicle \| (?:delivery to the recipient address is in progress|the courier has the shipment for delivery|the courier is heading to the delivery address|the delivery round is still open|the out-for-delivery scan is on record|the parcel is still out with the courier|the shipment has not been signed for|the shipment is on the delivery route)\.?$/, 'out_for_delivery'],
  // USPS's status title can be followed by its free-text description with the time and place.
  [/^delivered, front door\/porch -> your item was delivered at the front door or porch\b/, 'delivered'],
  [/^on the way in transit, arriving on time -> your package is moving within the usps network\b/, 'in_transit'],
  [/^on the way, departed usps facility -> your item departed our usps facility\b/, 'in_transit'],
  [/^on the way, arrived at usps facility -> your item arrived at our usps facility\b/, 'in_transit'],
  // The partner's sort and departure in China after its collection, naming the facility's town.
  [/^arrived at sort facility [a-z][a-z .-]{1,60}$/, 'in_transit'],
  [/^departed facility in [a-z][a-z .-]{1,60}$/, 'in_transit'],
  // The partner's hub in China named by a two-letter code ("Arrived at XX CENTER"), and a terminal abroad by its number.
  [/^arrived at [a-z]{2} center$/, 'in_transit'],
  [/^the package has arrived at terminal \(t\d{1,2}\)\.?$/, 'in_transit'],
  // A last mile's delivery to the letterbox, followed by its delivery note and its contact details.
  [/^delivered by mailbox(?:, |$)/, 'delivered'],
  // The Italian last mile's return of a parcel it could not deliver, whatever the reason it names:
  // on its way back, not yet with the sender.
  [/^back to sender for reason: \S/, 'exception'],
  // Its attempt that found no one or could not deliver, whatever the reason it names: tried again.
  [/^failed delivery for reason: \S/, 'failed_attempt'],
  // DHL's parcel on its way to the outlet that keeps it after a failed attempt, naming the outlet:
  // the card the recipient got says when it can be picked up, so it is not there yet.
  [/^the shipment is being brought to \[[^\]]{1,120}\]\. ?the earliest time when it can be picked up can be found on the notification card\.?$/, 'in_transit'],
];

// 17TRACK's sub-status names, which Shouwu gives as a scan's wording on a line it reads from 17TRACK
// ("InTransit_CustomsReleased"): they mean what 17TRACK's sub-statuses mean.
const SUB_STATUS_NAMES: ReadonlyMap<string, Stage> = new Map(Object.entries(SUB_STAGES)
  .map(([name, stage]) => [name.toLowerCase(), stage]));

// FedEx can relay these scans with the depot's place and ZIP before the wording.
const FEDEX_PLACE = /^[a-z][a-z .'-]{1,60}, [a-z]{2}, us, \d{5}(?:-\d{4})?, (picked up|arrived at fedex location|departed fedex location)$/;

/**
 * A wording's stage in Shouwu's map, the wording in `normalizeStatusWording` form. On the line into
 * Italy the delivering partner is iMile, whose rows open with its centre in 【】 ("【Milan center】Received."):
 * iMile's sentences read them.
 */
function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(unstopped(FEDEX_PLACE.exec(wording)?.[1] ?? wording)) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1] ?? SUB_STATUS_NAMES.get(wording)
    ?? imileRelayedStage(wording) ?? relayedSentence(wording) ?? withoutCarrierNote(wording);
}

function withoutCarrierNote(wording: string): Stage | undefined {
  return WORDINGS.get(unstopped(wording.replace(CARRIER_NOTE, '')));
}

// The last mile's own note appended to a scan: "Arrived at pick-up point. …, Carrier note: …".
const CARRIER_NOTE = /, carrier note: .*$/;

// The French last mile's sentence, which Shouwu gives after the country's code and before its own Chinese
// label: "FR, Votre envoi a été distribué dans la boîte à lettres.,签收…". The sentence alone is in the map.
const RELAYED_SENTENCE = /^[a-z]{2}, (.+?)(?:,[^,]*)?$/;

function relayedSentence(wording: string): Stage | undefined {
  const sentence = RELAYED_SENTENCE.exec(wording)?.[1];
  return sentence === undefined ? undefined : WORDINGS.get(unstopped(sentence));
}

// Rows that send the parcel back to its sender: DHL's "Shipment will be returned to origin-Bad address" and the
// Italian last mile's "Back to Sender for reason: …".
const SENDS_BACK = /^shipment will be returned to origin\b|^back to sender for reason: \S/;

/** Whether a scan's wording sends the parcel back to its sender. */
export const shouwuSendsBack = (wording: string): boolean => SENDS_BACK.test(normalizeStatusWording(wording));

/** The stage of a parcel's status code. */
export function shouwuStatusStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The page's label for a parcel's status code. */
export function shouwuStatusLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/** A scan's stage: the map, else the shared wording rules, else nothing; none for the flight booked. */
export function shouwuStage(wording: string): ClassifiedWording | null {
  if (isShouwuFlightBooked(wording)) return null;
  const mapped = mappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a parcel's status, by its code, or about a scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : FLIGHT_BOOKED.test(wording) ? undefined : mappedStage(wording)),
  // The last mile's rows after its failed delivery, minutes apart, while its station keeps the parcel, in English or Spanish.
  gaps: [...['stationed shipment', 'stationed located', 'envío estacionado', 'estacionado ubicado'].map((wording) => ({ wording,
    note: "The last mile's station keeping the parcel after a failed delivery: it says neither that the parcel waits for the recipient to collect nor that another round follows, so it names no stage." })),
  // The same station days later, the parcel to be taken out of its stock.
  { wording: 'pendiente de extracción',
    note: "The last mile's station, days after it kept the parcel, to take it out of its stock: it says neither that another round follows nor that the parcel goes back, so it names no stage." }],
  gapNote: (_code, wording) => (FLIGHT_BOOKED.test(wording)
    ? 'The flight booked for the parcel, before it flies: a forecast, so the parcel keeps the stage of the scan before it.'
    : undefined),
};
