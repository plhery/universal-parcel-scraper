import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { chinaPostCountry, chinaPostDestinationRows, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { localEvent, numberOf, place, result, text } from '../shared/result.js';
import { track123Carrier, track123CourierCode } from './couriers.js';

const SOURCE = 'Track123';
const ORIGIN = 'https://www.track123.com';
export const TRACK123_QUERY = `${ORIGIN}/tk/api/v2/anonymous/track/query-track-nos`;
export const TRACK123_POLL = `${ORIGIN}/tk/api/v2/anonymous/track/polling-waybill`;

const pageOf = (code: string) => `${ORIGIN}/carriers/${code}`;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

/**
 * Couriers whose scans at home Track123 labels with another offset than their own: it gives Japan
 * Post's +08:00, where the post's own tracker shows the same wall clocks on Tokyo time. A scan whose
 * place ends in the country's postcode is on that country's clock.
 */
const HOME_CLOCKS: Readonly<Record<string, { place: RegExp; zone: string }>> = {
  'japan-post': { place: /(?:^|[\s,])\d{3}-\d{4}$/, zone: 'Asia/Tokyo' },
};

function homeZone(code: string, address: unknown): string | null {
  const home = Object.hasOwn(HOME_CLOCKS, code) ? HOME_CLOCKS[code]! : null;
  return home && typeof address === 'string' && home.place.test(address.trim()) ? home.zone : null;
}

/** The zone a row's wall clock is read on, and how it was chosen (`time_zone_basis`); null keeps the wall clock alone. */
type Abroad = { zone: string; basis: 'place' | 'neighbour' } | null;

/**
 * China Post's copies of the destination post's own scans (`chinaPostDestinationRows`) keep that post's wall clock,
 * and Track123 labels them +08:00, as 17TRACK does: a processing centre's arrival abroad came hours before 17TRACK's
 * copy, which reads it on the recipient country's clock. Track123 names no recipient country, so those rows take the
 * zone of the one country they name, where it keeps one clock, and otherwise keep their wall clock alone. Returns
 * them by their index in the reply.
 */
function chinaPostAbroad(details: readonly unknown[]): Map<number, Abroad> {
  const rows = details.map((raw) => isRecord(raw) ? {
    wording: text(raw.eventDetail) || text(raw.desc),
    wall: typeof raw.eventTime === 'string' ? Date.parse(`${raw.eventTime.replace(' ', 'T')}Z`) : Number.NaN,
  } : { wording: '', wall: Number.NaN });
  const found = [...chinaPostDestinationRows(rows)];
  const named = new Map(found.flatMap((index) => {
    const place = chinaPostLabelPlace(rows[index]!.wording);
    const country = place === undefined ? undefined : chinaPostCountry(place);
    return country ? [[index, country] as const] : [];
  }));
  const countries = new Set(named.values());
  const lent = countries.size === 1 ? [...countries][0]! : null;
  return new Map(found.map((index): [number, Abroad] => {
    const own = named.get(index);
    const zone = countryTimeZone(own ?? lent);
    return [index, zone ? { zone, basis: own ? 'place' : 'neighbour' } : null];
  }));
}

/**
 * Reads the courier page's final reply for `number`. The shipment must be the one asked of the
 * courier `code` (FedEx's when omitted) and every event must repeat the number.
 */
export function parseTrack123Response(payload: unknown, number: string, code = 'fedex'): CarrierResult {
  if (!isRecord(payload) || typeof payload.code !== 'string') throw new SchemaError(SOURCE, 'Unreadable tracking reply');
  // A rejected guest request says nothing about shipment existence.
  if (payload.code !== '00000') throw new IndeterminateError(SOURCE, 'The guest tracking request was refused', { reason: 'guest_refused' });
  const records = isRecord(payload.data) ? payload.data.landWaybillLists : null;
  if (!Array.isArray(records) || records.length !== 1 || !isRecord(records[0])) throw new SchemaError(SOURCE, 'No unique shipment');
  const shipment = records[0];
  if (shipment.trackingNo !== number || shipment.localProviderCode !== code) {
    throw new SchemaError(SOURCE, 'The shipment does not match the requested number and courier');
  }
  if (shipment.querying !== false) throw new IndeterminateError(SOURCE, 'The provider is still retrieving history', { reason: 'query_pending' });
  if (!Array.isArray(shipment.localDetails) || shipment.localDetails.length > 1000) throw new SchemaError(SOURCE, 'Invalid tracking history');
  if (!shipment.localDetails.length) {
    // Track123 marks a courier site it could not read; that empty answer is about the courier, not the parcel.
    if (shipment.nodeStatus === 'UNSTABLE_OFFICIAL_WEBSITE') {
      throw new IndeterminateError(SOURCE, 'The provider could not reach the courier', { reason: 'carrier_unavailable' });
    }
    throw new NoHistoryError(SOURCE, 'No available tracking history');
  }
  const abroad = code === 'china-post' ? chinaPostAbroad(shipment.localDetails) : new Map<number, Abroad>();
  const events: CarrierEvent[] = [];
  for (const [index, raw] of shipment.localDetails.entries()) {
    if (!isRecord(raw) || raw.trackingNo !== number || typeof raw.eventTime !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.eventTime)) throw new SchemaError(SOURCE, 'Unbound or undated tracking event');
    const wall = raw.eventTime.replace(' ', 'T');
    const given = typeof raw.timezone === 'string' && OFFSET.test(raw.timezone) ? raw.timezone : null;
    const clock = DateTime.fromISO(given ? wall + given : wall, { setZone: true, zone: 'UTC' });
    if (!clock.isValid) throw new SchemaError(SOURCE, 'Invalid event clock');
    if (given && typeof raw.eventTimeUtc === 'string') {
      const utc = DateTime.fromISO(raw.eventTimeUtc.replace(' ', 'T'), { zone: 'UTC' });
      if (!utc.isValid || utc.toMillis() !== clock.toMillis()) throw new SchemaError(SOURCE, 'Conflicting event clocks');
    }
    const placed = abroad.get(index);
    const zone = homeZone(code, raw.address) ?? placed?.zone;
    const offset = zone ? firstOccurrence(DateTime.fromISO(wall, { zone })).toFormat('ZZ') : placed === null ? null : given;
    const event = localEvent(offset ? wall + offset : wall, text(raw.eventDetail) || text(raw.desc));
    if (event) events.push({ ...event, local_time: wall, ...(placed ? { time_zone: placed.zone, time_zone_basis: placed.basis } : {}),
      ...(place(raw.address) ? { location: place(raw.address) } : {}) });
  }
  const shown = text(shipment.localProviderEnName) || text(shipment.localProviderName);
  const carrier = track123Carrier(code);
  return { ...result(events, SOURCE), tracking_url: pageOf(code), ...(shown ? { reported_carriers: [shown] } : {}),
    ...(carrier ? { discovered_carrier: carrier } : {}) };
}

export const adapter: AdapterFactory = environment => ({
  id: SOURCE, recordsSteps: true, steps: ['trawl'],
  async track(input, context = {}) {
    const number = numberOf(input.number);
    const code = track123CourierCode(input.carrier);
    if (!code) {
      throw new IndeterminateError(SOURCE, 'This provider answers only for a named carrier it has a courier page for', { reason: 'unsupported_scope' });
    }
    return runSteps({ carrier: SOURCE, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 30_000 }, [{
      id: 'trawl', run: async ({ remainingMs, signal }) => {
        if (!environment.trawl) throw new TransportError(SOURCE, 'A browser service is required');
        const page = await environment.trawl.scrape({ url: `${pageOf(code)}#trawl-number=${number}`, skipHttp: true, maxTier: 3,
          maxTimeout: Math.max(1, Math.floor(remainingMs - 2000)), captureResponses: [TRACK123_QUERY, TRACK123_POLL] },
        { provider: SOURCE, timeoutMs: remainingMs, maxBytes: 5_000_000, fetcher: environment.fetcher, signal, captureWindow: 'last' });
        const entries = page.capturedResponses.filter(row => [TRACK123_QUERY, TRACK123_POLL].includes(row.url)
          && row.trackingNumberSubmitted === number);
        const last = entries.at(-1);
        if (!last) throw new ChallengeError(SOURCE, 'The public page did not complete guest tracking', { reason: 'guest_verification' });
        if ([401, 403].includes(last.status)) throw new ChallengeError(SOURCE, 'The guest tracking request was challenged');
        if (last.status >= 400) throw new UpstreamHttpError(SOURCE, last.status);
        if (last.status !== 200 || last.truncated || last.error || !last.body) throw new TransportError(SOURCE, 'Incomplete guest tracking response');
        let payload: unknown;
        try { payload = JSON.parse(last.body); } catch { throw new SchemaError(SOURCE, 'Unreadable guest tracking response'); }
        return parseTrack123Response(payload, number, code);
      },
    }]);
  },
});
