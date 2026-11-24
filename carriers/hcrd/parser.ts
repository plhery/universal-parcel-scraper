import { DateTime } from 'luxon';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { countryCode, usStateTimeZone } from '../../core/time/index.js';
import { gofoScanZone } from '../gofo/clock.js';
import { withoutGofoSupportLine } from '../gofo/support.js';
import { dateWallClocks } from '../gzyl/gofo-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { hcrdStage } from './status.js';

export const PROVIDER = 'HCRD';
export const HCRD_ORIGIN = 'http://www.xchcrd.com:8082';

// The row that hands the parcel to GOFO: "in transit via GOFO tracking number:GFUS…".
const HAND_OFF = /\bvia GOFO tracking number\s*[:：]\s*([A-Z0-9]{6,40})(?![A-Za-z0-9])/i;
// A US town and its state's code, as the tracker places the GOFO scans it reads on Beijing's clock ("Carteret, NJ").
const US_TOWN_STATE = /^[^,]+,\s*([A-Z]{2})$/;

/** A row's wording without the support line GOFO appends to its delivery, which names GOFO's phone and email. */
export function splitHcrdRow(content: string, location: string): { content: string; location: string } {
  return { content: withoutGofoSupportLine(content), location };
}

/**
 * A row's clock. The tracker lists each GOFO scan twice: under a US town and its state on the
 * platform's Beijing clock, and under the station's name alone on that station's wall clock. A row
 * placed under a bare name that is no country keeps its wall clock; the rest are on Beijing's.
 */
export function hcrdClock({ location, code }: HualeiRow): 'platform' | 'wall' {
  const place = location.trim();
  return !code && /\p{L}/u.test(place) && !place.includes(',') && !countryCode(place) ? 'wall' : 'platform';
}

/** Whether a scan on Beijing's clock at a US town and state reads `local` on that state's clock. */
function readsAt(event: CarrierEvent, local: string): boolean {
  const zone = usStateTimeZone(US_TOWN_STATE.exec(event.location ?? '')?.[1]);
  const time = event.time ? DateTime.fromISO(event.time, { setZone: true }) : null;
  return Boolean(zone && time?.isValid && time.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm:ss") === local);
}

/**
 * The result without the copies of GOFO's scans the tracker lists on a station's wall clock when it
 * also lists the same scan, in the same words, on Beijing's clock; the scans it lists on a wall clock
 * alone are dated on GOFO's clock for their station when GOFO names one.
 */
export function withoutHcrdGofoCopies(result: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  const copy = (event: CarrierEvent) => !event.time && Boolean(event.local_time)
    && events.some((other) => other.description === event.description && readsAt(other, event.local_time!));
  const kept = events.some(copy) ? { ...result, events: events.filter((event) => !copy(event)) } : result;
  return dateWallClocks(kept, (event) => {
    const zone = gofoScanZone(event.location ?? '', event.description ?? '');
    return zone ? { zone, basis: 'place' } : null;
  });
}

/**
 * HCRD's tenant of the Hualei platform. Its line to the United States hands the parcel to GOFO in a
 * row that names GOFO's number, without a channel or transfer number; GOFO's own rule claims it whole.
 */
export const HCRD: HualeiTenant = {
  carrier: 'hcrd', provider: PROVIDER, origin: HCRD_ORIGIN, stage: hcrdStage, split: splitHcrdRow, clock: hcrdClock,
  handOff: (content) => HAND_OFF.exec(content)?.[1], unlabelledPartners: ['gofo'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export function parseHcrdTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, HCRD, readAt);
  return result && withoutHcrdGofoCopies(result);
}
export const parseHcrdPage = (html: string, number: string, readAt?: number): CarrierResult =>
  withoutHcrdGofoCopies(parseHualeiPage(html, number, HCRD, readAt));
