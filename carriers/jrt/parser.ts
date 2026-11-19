import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { dateHualeiGofoRows, dateWallClocks, isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import {
  isJrtDhlGermanRow, isJrtDhlRow, isJrtJtMexicoRow, isJrtUpsRow, jrtCountryPlace, jrtEnglish, jrtStage,
} from './status.js';

export const PROVIDER = 'JRT';
export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe or FedEx's on the line to Ireland, whose product names FedEx, and JRT's
// own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) || isHualeiUsPartnerRow(content, location) || isJrtDhlRow(content)
    || isJrtJtMexicoRow(content) ? 'wall' : 'platform'),
  ownNumber: /^JRT\d{10}[A-Z]{2}$/, unlabelledPartners: ['dhl'], productPartners: [[/\bFEDEX\b/i, 'fedex']],
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

/** The result with the rows the tracker copies from DHL, J&T Express Mexico, GOFO and USPS dated on their clocks. */
export const dateJrtRows = (result: CarrierResult): CarrierResult =>
  dateJrtUspsSentences(dateHualeiGofoRows(dateJrtJtMexicoRows(dateJrtDhlRows(result))));

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && dateJrtRows(result);
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateJrtRows(parseHualeiPage(html, number, JRT, readAt));
