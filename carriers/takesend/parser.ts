import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { chinaClock } from '../china-post/parser.js';
import { takesendStage, takesendStatusStage } from './status.js';

export const PROVIDER = 'Take Send';
// One parcel's reply is about a kilobyte.
export const TAKESEND_MAX_BYTES = 256 * 1024;
const NUMBER = /^TS\d{13}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Take Send writes its own name in the place column of its own scans; it is no place.
const OWN_NAME = /^take ?send(?: logistics)?$/i;

/** A Take Send number: TS and thirteen digits, in capitals. */
export function normalizeTakesendNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Take Send numbers are TS and thirteen digits');
  return number;
}

function attribute(node: Cheerio<Element>, name: string, max = 300): string {
  const value = node.attr(name) ?? '';
  if (value.length > max) throw new SchemaError(PROVIDER, 'Take Send returned an invalid tracking field');
  return clean(value, max);
}

function clock(value: string): string {
  if (CLOCK.test(value)) {
    const local = value.replace(' ', 'T');
    if (DateTime.fromISO(local, { zone: 'UTC' }).isValid) return local;
  }
  throw new SchemaError(PROVIDER, 'Take Send returned an invalid scan clock');
}

/**
 * The partner's number the record names, in `transbillid` or `billid`, when that partner's own
 * rules claim it whole at high confidence: on the line to the United States, YWE's.
 */
function handoff(track: Cheerio<Element>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const name of ['transbillid', 'billid']) {
    const reference = normalizeTrackingNumber(attribute(track, name, 64)).toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(reference) || reference === number) continue;
    const match = detectCarrierMatch(reference);
    if (match.confidence === 'high' && match.carrier !== 'unknown' && match.carrier !== 'takesend') {
      return { delivery_carrier: match.carrier, delivery_tracking_number: reference };
    }
  }
  return {};
}

/**
 * A scan's clock. Take Send's scans in China are on Beijing's wall clock. Its scans placed at
 * another country's code, from the flight's last stop to the destination's customs, carry that
 * place's wall clock: read on Beijing's, a parcel landed in the United States four hours after
 * its last stop in Hong Kong. A country with one clock dates them; another keeps the wall clock
 * alone, for the facade to date by its place.
 */
function scanClock(local: string, place: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const country = countryCode(place);
  if (!country || country === 'CN') return chinaClock(local);
  const zone = countryTimeZone(country);
  const time = zone ? isoTime(local, zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

/**
 * The reply of the Kingtrans K5 tracker's `WebTrack?action=repeat` for one number: one `track`
 * under `xdoc/xout`, bound to the number by `searchBillid`. A record carries `transbillid` and its
 * scans as `trackitem`, newest first; a number the tracker does not know comes back echoed alone.
 */
export function parseTakesend(xml: string, raw: string): CarrierResult {
  const number = normalizeTakesendNumber(raw);
  const $ = load(xml, { xml: true });
  const tracks = $('xdoc > xout > track');
  if (tracks.length !== 1) throw new SchemaError(PROVIDER, 'Take Send returned no single tracking record');
  const track = tracks.first();
  if (normalizeTrackingNumber(attribute(track, 'searchBillid', 64)).toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Take Send answered for another number');
  }
  const items = track.children('trackitem');
  if (track.attr('transbillid') === undefined) {
    if (items.length) throw new SchemaError(PROVIDER, 'Take Send returned scans without a record');
    throw new NotFoundError(PROVIDER);
  }
  if (items.length > 500) throw new SchemaError(PROVIDER, 'Take Send returned an invalid history');
  const partner = handoff(track, number);
  if (!items.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed',
    deliveryCarrier: partner.delivery_carrier ?? undefined, deliveryTrackingNumber: partner.delivery_tracking_number ?? undefined });
  const events: CarrierEvent[] = items.toArray().map((element) => {
    const item = $(element);
    const description = attribute(item, 'intro') || attribute(item, 'statusnameus') || attribute(item, 'statusname');
    if (!description) throw new SchemaError(PROVIDER, 'Take Send returned an empty scan');
    const place = attribute(item, 'place', 200);
    const staged = takesendStage(description);
    return { ...scanClock(clock(attribute(item, 'sdate', 32)), place), description,
      ...(place && !OWN_NAME.test(place) ? { location: place } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  const newest = events[0]!;
  const latest = takesendStage(newest.description!);
  const summary = takesendStatusStage(attribute(track, 'trackstatus', 8));
  const current = latest ?? (summary ? { stage: summary, source: 'carrier_map' as const } : null);
  const country = countryCode(attribute(track, 'country', 80));
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description!, last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }), expected_delivery: null,
    ...(country ? { destination_country: country } : {}), ...partner,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
