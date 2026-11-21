import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { canadaProvinceTimeZone, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { dateHualeiGofoRows, dateWallClocks, isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import {
  isJrtDhlGermanRow, isJrtDhlRow, isJrtJtMexicoRow, isJrtUpsRow, jrtCountryPlace, jrtEnglish, jrtStage,
} from './status.js';

export const PROVIDER = 'JRT';

// On the line into Canada the tracker copies the courier's rows, and the customs release before them,
// under the town and its province's code ("Example Town ON"), on the wall clock there: read on Beijing
// time, UniUni's receipt came 13 hours before UniUni's own row at the same minute and second.
const CANADA_TOWN = /^[^,]*\p{L}[^,]*?[ ,]\s*(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/u;
/** The zone of a place the tracker writes as a Canadian town and its province's code; null for another place. */
export const jrtCanadaZone = (place: string): string | null => canadaProvinceTimeZone(CANADA_TOWN.exec(place.trim())?.[1]);

export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe, CTT Express's into Spain or FedEx's on the line to Ireland, whose product
// names FedEx, and JRT's own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) || isHualeiUsPartnerRow(content, location) || isJrtDhlRow(content)
    || isJrtJtMexicoRow(content) || jrtCanadaZone(location) !== null ? 'wall' : 'platform'),
  ownNumber: /^JRT\d{10}[A-Z]{2}$/, unlabelledPartners: ['dhl', 'ctt-express'], productPartners: [[/\bFEDEX\b/i, 'fedex']],
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock, and a country's code beside them shown as one. */
export function dateJrtDhlRows(result: CarrierResult): CarrierResult {
  const dated = dateDhlRows(result, { isRow: isJrtDhlRow, isGermanRow: isJrtDhlGermanRow });
  if (!dated.events?.some((event) => event.location && isJrtDhlRow(event.description ?? '') && jrtCountryPlace(event.location) !== event.location)) return dated;
  return {
    ...dated,
    events: dated.events.map((event) => (event.location && isJrtDhlRow(event.description ?? '') ? { ...event, location: jrtCountryPlace(event.location) } : event)),
  };
}

// J&T Express Mexico writes its scans on Mexico City's clock, as its own tracker answers them.
const JT_MEXICO_ZONE = 'America/Mexico_City';

/** The result with the rows the tracker copies from J&T Express Mexico dated on J&T's clock. */
export const dateJrtJtMexicoRows = (result: CarrierResult): CarrierResult => dateWallClocks(result,
  (event) => (isJrtJtMexicoRow(event.description ?? '') ? { zone: JT_MEXICO_ZONE, basis: 'carrier' } : null));

/** The result with the rows at a Canadian town dated on its province's clock. */
export const dateJrtCanadaRows = (result: CarrierResult): CarrierResult => dateWallClocks(result, (event) => {
  const zone = jrtCanadaZone(event.location ?? '');
  return zone ? { zone, basis: 'place' } : null;
});

// USPS's sentence names its own clock, day and the facility's state ("… at 3:14 am on November 9, 2026 in EXAMPLE, IL.").
// The tracker dates it an hour early, on Eastern time, beside the partner's own row at that minute on Chicago's.
const USPS_SENTENCE_CLOCK = / -> your item\b.{0,120}? at (\d{1,2}:\d{2} [ap]m) on ([A-Z][a-z]{2,8} \d{1,2}, \d{4}) in [^.]{1,80}?,\s*([A-Z]{2})\s*\./i;
const instant = (event: CarrierEvent | undefined): number => (event?.time ? Date.parse(event.time) : Number.NaN);

/** The result with each USPS sentence dated at the clock it names, in its facility's state, newest first among the dated rows. */
export function dateJrtUspsSentences(result: CarrierResult): CarrierResult {
  const named = (event: CarrierEvent) => {
    const parts = USPS_SENTENCE_CLOCK.exec(event.description ?? '');
    const zone = parts ? usStateTimeZone(parts[3]) : null;
    const wall = parts && zone ? firstOccurrence(DateTime.fromFormat(`${parts[2]} ${parts[1]}`, 'MMMM d, yyyy h:mm a', { zone, locale: 'en-US' })) : null;
    const time = wall?.isValid ? wall.toISO({ suppressMilliseconds: true }) : null;
    return time && zone ? { time, zone } : null;
  };
  if (!result.events?.some(named)) return result;
  const events = [...result.events];
  events.forEach((event, index) => {
    const clock = named(event);
    if (!clock) return;
    const dated: CarrierEvent = { ...event, time: clock.time, time_zone: clock.zone, time_zone_basis: 'place' };
    delete dated.local_time;
    let at = index;
    events[at] = dated;
    while (at > 0 && instant(events[at - 1]) < instant(events[at])) {
      [events[at - 1], events[at]] = [events[at]!, events[at - 1]!];
      at -= 1;
    }
  });
  return { ...result, last_update: events[0]?.time ?? result.last_update, events };
}

// DHL loads a parcel "to movement / tour vehicle" for a trunk run as for its round. Straight after the
// destination parcel centre it is the round, unless the record holds DHL's export rows: that centre is then
// the export centre in Germany, and the vehicle takes the parcel abroad.
const LOADED = normalizeStatusWording('loaded to movement / tour vehicle');
const DESTINATION_CENTRE = normalizeStatusWording('the shipment has been processed in the destination parcel center');
const DHL_EXPORT = /\bexport parcel center\b|\btransported to the destination country\b/i;

/** The result with DHL's load straight after the destination parcel centre, on a parcel DHL did not export, out for delivery. */
export function stageJrtDhlRounds(result: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  const wording = (event: CarrierEvent | undefined) => normalizeStatusWording(event?.description ?? '');
  const rounds = events.map((event, index) => wording(event) === LOADED && wording(events[index + 1]) === DESTINATION_CENTRE);
  if (!rounds.includes(true) || events.some((event) => DHL_EXPORT.test(event.description ?? ''))) return result;
  const staged = events.map((event, index): CarrierEvent => (rounds[index] ? { ...event, stage: 'out_for_delivery' } : event));
  const current = staged.find((event) => event.stage && event.stage !== 'pending');
  const round = current !== undefined && rounds[staged.indexOf(current)];
  return { ...result, events: staged, ...(round ? { status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery' } : {}) };
}

/** The result with the rows the tracker copies from DHL, J&T Express Mexico, the courier into Canada, GOFO and USPS dated on their clocks. */
export const dateJrtRows = (result: CarrierResult): CarrierResult =>
  dateJrtUspsSentences(dateHualeiGofoRows(dateJrtCanadaRows(dateJrtJtMexicoRows(dateJrtDhlRows(result)))));

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && stageJrtDhlRounds(dateJrtRows(result));
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  stageJrtDhlRounds(dateJrtRows(parseHualeiPage(html, number, JRT, readAt)));
