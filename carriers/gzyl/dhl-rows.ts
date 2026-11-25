import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { locatePlace, placeTimeZone, type ZoneBasis } from '../../places/index.js';
import { mainZone } from '../../places/zones.js';
import type { HualeiRow } from './hualei.js';

/** Which rows of a tenant's record are DHL's, and which of those DHL wrote in Germany. */
export interface DhlRows {
  /** Whether a row is one the tracker copies from DHL, on DHL's wall clock where it scanned the parcel. */
  readonly isRow: (wording: string) => boolean;
  /** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
  readonly isGermanRow: (wording: string) => boolean;
}

// DHL's clock in Germany, where its rows on the lines into Europe start.
const DHL_ZONE = 'Europe/Berlin';

/** The clock of a town DHL names, as "hagen" or "frankfurt, hessian, de", in the destination or Germany. */
function townZone(location: string, country: string | null): [string, ZoneBasis] | null {
  const place = location.trim() ? locatePlace(location, { countries: country ? [country, 'DE'] : ['DE'] }) : null;
  const zone = place?.precision === 'city' ? placeTimeZone(place) : null;
  return zone ? [zone, 'place'] : null;
}

/**
 * The result with the rows a Hualei tenant copies from DHL dated, each keeping
 * its wall clock: a row naming a town on that town's clock; else DHL's rows
 * from Germany on DHL's German clock, the others on the destination's, where
 * DHL or its partner delivers, else on DHL's. A country's code beside a row, as
 * the tracker writes the destination's, names no town. The newest row's
 * instant, when it has one, is the last update. The tenant's clock option keeps
 * those rows as wall clocks.
 */
export function dateDhlRows(result: CarrierResult, rows: DhlRows): CarrierResult {
  const country = /^[A-Z]{2}$/.test(result.destination_country ?? '') ? result.destination_country! : null;
  const destination = country ? mainZone(country) : null;
  const events = result.events?.map((event): CarrierEvent => {
    const description = event.description ?? '';
    if (event.time || !event.local_time || !rows.isRow(description)) return event;
    const [zone, basis] = townZone(event.location ?? '', country)
      ?? (rows.isGermanRow(description) || !destination ? [DHL_ZONE, 'carrier'] : [destination, 'destination']);
    const time = firstOccurrence(DateTime.fromISO(event.local_time, { zone })).toISO({ suppressMilliseconds: true });
    return time ? { ...event, time, time_zone: zone, time_zone_basis: basis } : event;
  });
  if (!events) return result;
  const newest = events[0];
  const { last_update_local: local, ...rest } = result;
  return { ...rest, last_update: newest?.time ?? result.last_update, ...(newest?.time || !local ? {} : { last_update_local: local }), events };
}

// DHL's English sentences a tenant copies on a line into Germany, on DHL's wall clock where it scanned the parcel, and
// those from Germany before the parcel leaves for another destination country. Suoexpress's and YCEX's lines copy them.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b|(?:un)?loaded (?:to|from) movement \/ tour vehicle\b)/i;
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country)\b/i;

/** Whether a row is one of DHL's sentences a tenant copies, on DHL's wall clock. */
export const isHualeiDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isHualeiDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);

/**
 * The clock of a tenant whose rows are its own or DHL's sentences: its own, in China or without a
 * place, are on the platform's Beijing clock. A row copied from DHL, placed or not, keeps its wall
 * clock: it is on DHL's clock where DHL scanned the parcel, and the tracker writes no zone.
 */
export const hualeiDhlClock = ({ content }: HualeiRow): 'platform' | 'wall' => (isHualeiDhlRow(content) ? 'wall' : 'platform');

/** The result with the rows such a tenant copies from DHL dated, each keeping its wall clock. */
export const dateHualeiDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isHualeiDhlRow, isGermanRow: isHualeiDhlGermanRow });
