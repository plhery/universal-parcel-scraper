import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isJrtDhlGermanRow, isJrtDhlRow, isJrtJtMexicoRow, isJrtUpsRow, jrtCountryPlace, jrtEnglish, jrtStage } from './status.js';

export const PROVIDER = 'JRT';
export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe or FedEx's on the line to Ireland, whose product names FedEx, and JRT's
// own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) || isJrtDhlRow(content) || isJrtJtMexicoRow(content) ? 'wall' : 'platform'),
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
export function dateJrtJtMexicoRows(result: CarrierResult): CarrierResult {
  if (!result.events?.some((event) => !event.time && event.local_time && isJrtJtMexicoRow(event.description ?? ''))) return result;
  const events = result.events.map((event): CarrierEvent => {
    if (event.time || !event.local_time || !isJrtJtMexicoRow(event.description ?? '')) return event;
    const time = firstOccurrence(DateTime.fromISO(event.local_time, { zone: JT_MEXICO_ZONE })).toISO({ suppressMilliseconds: true });
    return time ? { ...event, time, time_zone: JT_MEXICO_ZONE, time_zone_basis: 'carrier' } : event;
  });
  const newest = events[0];
  const { last_update_local: local, ...rest } = result;
  return { ...rest, last_update: newest?.time ?? result.last_update, ...(newest?.time || !local ? {} : { last_update_local: local }), events };
}

/** The result with the rows the tracker copies from DHL and J&T Express Mexico dated on their clocks. */
export const dateJrtRows = (result: CarrierResult): CarrierResult => dateJrtJtMexicoRows(dateJrtDhlRows(result));

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && dateJrtRows(result);
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateJrtRows(parseHualeiPage(html, number, JRT, readAt));
