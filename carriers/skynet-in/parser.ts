import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean, cleanScalar, escapeRegExp } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { skynetInLabel, skynetInStage, statusMap } from './status.js';

export const PROVIDER = 'skynet-in';
// One shipment's reply is a few kilobytes.
export const SKYNET_IN_MAX_BYTES = 512 * 1024;
/** The source the tracking service names for Skynet India's own bookings, the only one the adapter reads. */
export const SKYNET_IN_SOURCE = 'skynetapi';

// The page keeps the letters and digits of what it is given and sends any of them; the adapter wants a digit too.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|captcha/i;
// The badge the page gives a shipment it found.
const CATEGORIES = new Set(['delivered', 'out-for-delivery', 'in-transit', 'exception']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// `dateLabel`: "January 21, 2026", as the service writes it in English.
const DATE_LABEL = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/;
// `time`: "15:24:04".
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const MAX_RESULTS = 10;
const MAX_EVENTS = 300;
const MAX_DETAIL_ROWS = 50;

// A scan's wording that goes on to name who took the parcel: the phrase stays, without its preposition.
const TAKEN_BY = /\b(received|signed|collected|accepted|delivered|handed over)\s+(?:by|to)\b.*$/i;
// Phone numbers in a scan's wording: eight digits or more, maybe grouped.
const DIGITS = /(?<![\p{L}\d])\+?\d(?:[\s.-]?\d){7,}(?!\d)/gu;

/** A number Skynet India's tracking page takes: letters and digits with a digit, separators dropped. */
export function normalizeSkynetInNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Skynet India air waybill number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
// The page sends the letters and digits of a number; the service names it back the same way.
const folded = (value: unknown): string => cleanScalar(value, 80).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** The tracking service's reply as JSON, or the failure a page in its place means. */
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Skynet India answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Skynet India answered with a page instead of its tracking JSON', { cause });
  }
}

/** A list of the reply: absent is empty; anything else than a list of objects is a changed reply. */
function rowsOf(value: unknown, max: number, what: string): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) return invalid(`Skynet India returned invalid ${what}`);
  return value;
}

/** A scan's wall clock from its `dateLabel` and `time`; the day alone without a time. The service names no zone. */
function wallClock(dateLabel: unknown, time: unknown): string {
  const [day, clock] = [clean(dateLabel, 40), clean(time, 20)];
  const date = DATE_LABEL.exec(day);
  const month = date ? MONTHS.indexOf(date[1]!.toLowerCase()) + 1 : 0;
  const calendar = date && month ? calendarDay(Number(date[3]), month, Number(date[2])) : null;
  if (!calendar) return invalid('Skynet India returned a scan without a readable date');
  if (!clock) return calendar;
  const parts = TIME.exec(clock);
  if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59 || Number(parts[3] ?? 0) > 59) return invalid('Skynet India returned an invalid scan time');
  return `${calendar}T${parts[1]!.padStart(2, '0')}:${parts[2]}:${parts[3] ?? '00'}`;
}

/** A detail row's value by its label key, or '' without one. */
function detail(rows: readonly Record<string, unknown>[], label: string): string {
  return clean(rows.find((row) => row.label === label)?.value, 200);
}

/** A scan's wording without the name of whoever took the parcel, the receiver's name or a phone number. */
export function withoutPeople(wording: string, names: readonly string[]): string {
  let cut = wording.replace(TAKEN_BY, (_, verb: string) => verb);
  for (const name of names) {
    if (name.length < 3 || !/\p{L}/u.test(name)) continue;
    cut = cut.replace(new RegExp(escapeRegExp(name).replace(/ /g, '\\s+'), 'giu'), ' ');
  }
  return clean(cut.replace(DIGITS, ' '), 500).replace(/\s+([,;:.])/g, '$1').replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');
}

/** One scan as the page shows it: the service's wording, else the label of its key, else its status. */
function scanOf(row: Record<string, unknown>, names: readonly string[]): CarrierEvent {
  const key = clean(row.labelKey, 60);
  const status = clean(row.status, 80);
  const code = key || status;
  const description = withoutPeople(clean(row.details, 500), names) || (key ? skynetInLabel(key) ?? '' : '') || status;
  if (!description) return invalid('Skynet India returned a scan without wording');
  const location = clean(row.location, 120);
  // A key the map does not know is read by its wording, else left without a stage.
  const mapped = key ? skynetInStage(key) : undefined;
  const gap = key && skynetInLabel(key) && !mapped;
  const worded = mapped || gap ? null : classifyWording(description, 'in_transit');
  const staged = mapped ? { stage: mapped, stage_source: 'carrier_map' } : worded && worded.source !== 'none'
    ? { stage: worded.stage, stage_source: worded.source } : {};
  return { local_time: wallClock(row.dateLabel, row.time), ...(location ? { location } : {}), description,
    ...(code ? { provider_code: code } : {}), ...staged };
}

/** The destination after the page's arrow: its country, by name, or the name it gives. */
function destinationOf(route: unknown): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  if (route === null || route === undefined) return {};
  if (!isRecord(route)) return invalid('Skynet India returned an invalid route');
  const name = clean(route.to, 80);
  const code = countryCode(name);
  return code ? { destination_country: code } : name ? { destination_country_name: name } : {};
}

/**
 * Whether the number has the partner's shape: one of the partner's detection rules offers it or,
 * for a partner whose rules claim no shape, its own tracking link in the reply opens that number.
 */
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as string[]).includes(partner)) return true;
  if (CARRIER_DEFINITIONS[partner as CarrierId]?.detectionRules.length !== 0) return false;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * The carrier a shipment was forwarded to, and the number it tracks it under. The page names the
 * carrier only through its "Track on carrier" link, so both stand when that link is one catalog
 * carrier's and the forwarding number, or else the number the link opens, has that carrier's
 * shape. The link is never followed.
 */
function partner(result: Record<string, unknown>, own: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const link = clean(result.carrierUrl, 500);
  if (!/^https?:\/\//i.test(link)) return {};
  const carrier = carrierIdFromPartner('', link);
  if (!carrier || carrier === PROVIDER) return {};
  const linked = parseTrackingInput(link);
  const forwarded = normalizeTrackingNumber(cleanScalar(result.forwarderNo, 64)).toUpperCase();
  const reference = forwarded || (linked.source === 'link' && linked.carrier === carrier ? linked.trackingNumber.toUpperCase() : '');
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === own || !partnerShape(carrier, reference, link)) return {};
  return { delivery_carrier: carrier, delivery_tracking_number: reference };
}

/** The one result the service gives for the number asked. */
function resultFor(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload)) return invalid('Skynet India returned an invalid tracking reply');
  const results = rowsOf(payload.results, MAX_RESULTS, 'results');
  if (results.length !== 1) return invalid('Skynet India returned another count of results than the one number asked');
  const result = results[0]!;
  if (typeof result.found !== 'boolean') return invalid('Skynet India returned a result without its answer');
  if (folded(result.awb) !== number) throw new IndeterminateError(PROVIDER, 'Skynet India answered for another number');
  return result;
}

/**
 * The reply of `POST /api/tracking` for one air waybill: `results` with one result per number
 * asked. A result found is Skynet India's booking, `provider` `skynetapi`, with its status, label
 * key, route and scans newest first, each with its English date and wall clock. A number it does
 * not know is `found: false` with the `not-found` badge and no scans; a lookup its partners did not
 * answer in time is `found: false` with `timedOut`. The recipient's name, the references, the
 * remarks and the proof of delivery image are not read.
 */
export function parseSkynetIn(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSkynetInNumber(raw);
  const result = resultFor(payload, number);
  const events = rowsOf(result.events, MAX_EVENTS, 'scans');
  if (!result.found) {
    if (result.timedOut === true) throw new TransportError(PROVIDER, 'Skynet India\'s tracking partners did not answer in time');
    if (result.category !== 'not-found' || events.length) return invalid('Skynet India returned an unknown answer without its not-found badge');
    throw new NotFoundError(PROVIDER, 'Skynet India has no shipment under this air waybill');
  }
  // Another source behind the service would bring its own vocabulary.
  if (result.provider !== SKYNET_IN_SOURCE) return invalid('Skynet India answered from another source than its booking system');
  if (!CATEGORIES.has(clean(result.category, 40))) return invalid('Skynet India returned a shipment without its badge');
  const awb = folded(result.airwayBillNo);
  if (awb && awb !== number) throw new IndeterminateError(PROVIDER, 'Skynet India found the number under another air waybill');

  const rows = rowsOf(result.detailRows, MAX_DETAIL_ROWS, 'details');
  const names = [detail(rows, 'receiver')].filter(Boolean);
  const scans = events.map((row) => scanOf(row, names));
  // Newest first, as the page lists them; an oldest-first history is turned round.
  if (listsNewestFirst(scans) === false) scans.reverse();
  const newest = scans[0];
  // The service lists the booking without a scan yet.
  if (!newest) throw new NoHistoryError(PROVIDER, 'Skynet India lists the shipment without a scan yet', { reason: 'listed' });

  const key = clean(result.statusLabelKey, 60);
  const lead = leadingScan(scans, statusMap);
  // Without a staged scan, the shipment's own label key gives the stage.
  const stage = (lead?.stage ?? (key ? skynetInStage(key) : undefined)) as Stage | undefined;
  const code = key || clean(result.status, 80);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...destinationOf(result.route),
    ...partner(result, number),
    events: scans,
  };
}

/** The tracking service's reply body: its JSON, a browser check, or a changed service. */
export function parseSkynetInReply(body: string, raw: string): CarrierResult {
  return parseSkynetIn(jsonOf(body), raw);
}
