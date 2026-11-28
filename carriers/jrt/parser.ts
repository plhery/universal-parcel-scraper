import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { canadaProvinceTimeZone, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { dateHualeiGofoRows, dateWallClocks, isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import { dateJtMexicoRows } from '../gzyl/jt-mexico-rows.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import {
  isJrtDhlGermanRow, isJrtDhlRow, isJrtFlightNotice, isJrtJtMexicoRow, isJrtUpsRow, jrtCountryPlace, jrtEnglish, jrtStage,
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
  notice: (_code, wording) => isJrtFlightNotice(wording),
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

/** The result with the rows the tracker copies from J&T Express Mexico dated on J&T's clock. */
export const dateJrtJtMexicoRows = dateJtMexicoRows;

/** The result with the rows at a Canadian town dated on its province's clock. */
export const dateJrtCanadaRows = (result: CarrierResult): CarrierResult => dateWallClocks(result, (event) => {
  const zone = jrtCanadaZone(event.location ?? '');
  return zone ? { zone, basis: 'place' } : null;
});

// USPS's sentence names its own clock, day and the facility's state ("… at 3:14 am on November 9, 2026 in EXAMPLE, IL.").
// The tracker dates it an hour early, on Eastern time, beside the partner's own row at that minute on Chicago's.
const USPS_SENTENCE_CLOCK = / -> your item\b.{0,120}? at (\d{1,2}:\d{2} [ap]m) on ([A-Z][a-z]{2,8} \d{1,2}, \d{4}) in [^.]{1,80}?,\s*([A-Z]{2})\s*\./i;
const instant = (event: CarrierEvent | undefined): number => (event?.time ? Date.parse(event.time) : Number.NaN);

/**
 * The result with each USPS sentence dated at the clock it names, in its facility's state, newest first among the
 * dated rows. A row `dates` refuses keeps its clock.
 */
export function dateJrtUspsSentences(result: CarrierResult, dates: (event: CarrierEvent) => boolean = () => true): CarrierResult {
  const named = (event: CarrierEvent) => {
    const parts = dates(event) ? USPS_SENTENCE_CLOCK.exec(event.description ?? '') : null;
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

// USPS's scans can reach the tracker three times: under the place with the country's code after it ("EXAMPLE
// TOWN, ST 00000 US"), seconds after the scan; under the place alone, at the scan's second; and under the place
// alone an hour early, in the status alone or with USPS's sentence after the arrow. Each scan is kept once, on its
// clock: the copy under the place alone when one comes at that clock, else the one with the code. Where every copy
// under the place alone came an hour early, as at the delivering post office, a row there with no other copy, such
// as the delivery, is moved on the hour too.
const COUNTRY_CODE_TAIL = / [A-Z]{2}$/;
const HOUR = 3_600_000;
const SKEW = 60_000;

/** The result with each USPS scan the tracker copies kept once, on its clock. */
export function dateJrtUspsCopies(result: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  const places = new Set(events.map((event) => event.location ?? ''));
  const coded = (event: CarrierEvent) => COUNTRY_CODE_TAIL.test(event.location ?? '') && places.has(event.location!.slice(0, -3));
  if (!events.some(coded)) return result;
  const placeOf = (event: CarrierEvent) => (coded(event) ? event.location!.slice(0, -3) : event.location ?? '');
  const statusOf = (event: CarrierEvent) => normalizeStatusWording((event.description ?? '').split(' -> ')[0]!);
  const copiedPlaces = new Set(events.filter(coded).map(placeOf));
  const copies = (event: CarrierEvent, lead: number) => (copiedPlaces.has(placeOf(event)) ? events.filter((other) => other !== event
    && placeOf(other) === placeOf(event) && statusOf(other) === statusOf(event) && Math.abs(instant(other) - instant(event) - lead) < SKEW) : []);
  const early = (event: CarrierEvent) => copies(event, HOUR).length > 0;
  const dropped = new Set(events.filter((event) => early(event) || (coded(event) && copies(event, 0).some((other) => !coded(other)))));
  const latePlaces = new Set([...copiedPlaces].filter((place) => {
    const alone = events.filter((event) => !coded(event) && event.location === place);
    return alone.some(early) && !alone.some((event) => copies(event, 0).some(coded));
  }));
  const moved = new Set<CarrierEvent>();
  const kept = events.filter((event) => !dropped.has(event)).map((event) => {
    if (coded(event) || !latePlaces.has(event.location ?? '') || copies(event, 0).length || !event.time) return event;
    const time = DateTime.fromISO(event.time, { setZone: true }).plus({ hours: 1 }).toISO({ suppressMilliseconds: true });
    if (!time) return event;
    const next = { ...event, time };
    moved.add(next);
    return next;
  });
  if (!dropped.size && !moved.size) return result;
  for (let index = 0; index < kept.length; index++) {
    if (!moved.has(kept[index]!)) continue;
    for (let at = index; at > 0 && instant(kept[at - 1]) < instant(kept[at]); at--) [kept[at - 1], kept[at]] = [kept[at]!, kept[at - 1]!];
  }
  return { ...result, last_update: kept[0]?.time ?? result.last_update, events: kept };
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

/**
 * The result with the rows the tracker copies from DHL, J&T Express Mexico, the courier into Canada, GOFO and USPS
 * dated on their clocks. A USPS row moved on the hour with the copies at its place keeps that clock.
 */
export function dateJrtRows(result: CarrierResult): CarrierResult {
  const dated = dateHualeiGofoRows(dateJrtCanadaRows(dateJrtJtMexicoRows(dateJrtDhlRows(result))));
  const unmoved = new Set(dated.events);
  return dateJrtUspsSentences(dateJrtUspsCopies(dated), (event) => unmoved.has(event));
}

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && stageJrtDhlRounds(dateJrtRows(result));
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  stageJrtDhlRounds(dateJrtRows(parseHualeiPage(html, number, JRT, readAt)));
