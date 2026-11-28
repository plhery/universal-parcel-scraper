
/**
 * PostNL international tracking (carrier id `spring-gds`).
 *
 * The folder keeps the historical `spring-gds` id for parcels and clients that
 * already store it; the carrier is presented as PostNL everywhere else. Spring
 * GDS is PostNL's international subsidiary and its mailingtechnology.com
 * portal shows the same barcode (see this folder's README).
 *
 * `postnl.post` hands out a visitor token that lasts a day to anyone who asks,
 * then accepts a batch tracking request with it. The tracker keeps the token
 * for its later lookups. Both calls replay once after a transport failure or an
 * HTTP 502/503/504. The token call replays after an HTTP 429 only when it
 * supplies a short, valid `Retry-After` that ends before the lookup does. The
 * tracking call's quota is kept by several backends and shared with every
 * visitor, so a 429 there is replayed every 2 s, and just after each wait PostNL
 * names, until the lookup's deadline. A 429 left standing names how many tries
 * the call made and the wait PostNL asked for.
 *
 * The response echoes the requested barcodes, so the item whose `item` equals
 * the requested number is the only one read. PostNL answers an unknown barcode
 * with an ordinary item that has no events and says so in `message`.
 *
 * A 3S barcode sent within the Netherlands is not there: PostNL's domestic
 * tracker on jouw.postnl.nl shows it, given the barcode, the country and the
 * delivery postcode, as it shows a postal item from abroad PostNL delivers under
 * its S10 number. With a Dutch postcode, or another country's postcode given
 * with that country, that tracker is asked first.
 */
import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { DateTime } from 'luxon';
import {
  CarrierError, IndeterminateError, InputRequiredError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
  UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { windowEstimate, type WindowEstimate } from '../../core/result/window.js';
import { runSteps } from '../../core/runner/index.js';
import { paused } from '../../core/runner/pause.js';
import { classifyWording, languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryTimeZone, explicitOffsetTime, firstOccurrence, mislabeledWallTime, settleGuessedClocks, type FeedClock, type ParsedTime } from '../../core/time/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { postNLCode, postNLDomesticStage, postNLStatus } from './status.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

const PROVIDER = 'PostNL';
const RECOGNIZED = new RegExp(CARRIER_DEFINITIONS['spring-gds']?.tracking.recognitionPattern ?? '(?!)');
const TOKEN_URL = 'https://postnl.post/api/v1/auth/token';
const TRACK_URL = 'https://postnl.post/api/v1/tracking-items';
const DOMESTIC_URL = 'https://jouw.postnl.nl/track-and-trace/api/trackAndTrace';
const TOKEN_TIMEOUT_MS = 10_000;
const DOMESTIC_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 25_000;
/**
 * The tracking call's quota of 20 calls a minute is kept by each of several backends and shared with every visitor of
 * the site. A refusal's `Retry-After` names the window of the backend that refused, which jumps by tens of seconds
 * between calls a few seconds apart, while another backend often has room, and a try succeeds only now and then: a
 * refused call is replayed every `QUOTA_PAUSE_MS`, and `WAIT_MARGIN_MS` after each wait PostNL named ends, while a
 * try still fits before the lookup's deadline with `REQUEST_RESERVE_MS` for the request itself.
 */
const QUOTA_PAUSE_MS = 2_000;
const MIN_QUOTA_PAUSE_MS = 1_000;
const WAIT_MARGIN_MS = 250;
const REQUEST_RESERVE_MS = 1_500;
/**
 * A tracking call refused on at least `TRACKING_TRIES` tries met the quota full on each backend it reached. No call
 * goes out after it until the soonest `Retry-After` its tries were given that has not passed, 2 s when all have,
 * `QUOTA_REST_MS` when none was given, and at most `QUOTA_REST_MAX_MS`.
 */
const TRACKING_TRIES = 5;
const QUOTA_REST_MS = 30_000;
const QUOTA_REST_MAX_MS = 60_000;
/** The time a lookup that waited for its turn or the rest keeps for its own calls. */
const TURN_RESERVE_MS = 3_000;
const MAX_TOKEN_LENGTH = 16_384;
// Visitor tokens last a day (`expires_in: 86400`); one is renewed this long before it expires.
const MAX_TOKEN_LIFETIME_MS = 86_400_000;
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;
// A barcode PostNL holds no shipment under. "Incorrect" says the same only for a
// fifteen-character 3S barcode with a four-letter customer code, the layout the endpoint
// reads: there it marks a code PostNL did not issue, such as DHL eCommerce's. The endpoint
// calls every thirteen- and fourteen-character 3S barcode incorrect, PostNL's own Parcel EU ones included.
const NOT_FOUND_MESSAGE = /barcode was not found/i;
const INCORRECT_MESSAGE = /barcode was incorrect/i;
const READABLE_3S = /^3S[A-Z]{4}\d{9}$/;
// The 3S barcodes the domestic tracker may hold, and the Dutch postcode it takes them with.
const THREE_S = /^(?:(?=.{13}$|.{15}$)3S[A-Z]{1,4}\d+|3S[A-Z]{4}\d{8})$/;
/** The numbers the domestic tracker holds: PostNL's 3S barcodes, and the S10 number of a postal item PostNL delivers. */
function domesticNumber(number: string): boolean {
  return THREE_S.test(number) || isValidS10TrackingNumber(number);
}
const DUTCH_POSTCODE = /^([1-9]\d{3}) ?([A-Z]{2})$/;
// A postcode abroad, as the tracking page sends it: the page splits its key on hyphens.
const FOREIGN_POSTCODE = /^[A-Z0-9]{2,10}$/;
const DOMESTIC_MESSAGE = 'PostNL shows a parcel sent within the Netherlands only with its delivery postcode';
// PostNL's own records (the pre-advice, the shipper's data) name no country and
// keep Amsterdam time. See this folder's README for the evidence.
const HOME_ZONE = 'Europe/Amsterdam';
// Except the label's creation and the processing record without a country,
// which keep UTC.
const UTC_RECORDS = new Set(['2001', '3033']);

/** The zone of one of PostNL's own records, which name no country, by its code. */
export function postnlRecordZone(code: string | undefined): string {
  return UTC_RECORDS.has(code ?? '') ? 'UTC' : HOME_ZONE;
}
// Customs and bagging records carry seven fraction digits and a real "Z".
const PRECISE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{4,7}Z$/;

function siteHeaders(userAgent: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    Origin: 'https://postnl.post',
    Referer: 'https://postnl.post/',
  };
}

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function comparableIdentifier(value: unknown): string {
  return text(value).trim().toLocaleUpperCase('en-US');
}

/** The event's numeric `status`, PostNL's code for the scan. */
function eventCode(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return /^\d{1,8}$/.test(text(value).trim()) ? text(value).trim() : undefined;
}

/** A wall clock read in `zone`, refusing DST gap shifts and repeated clocks rather than choosing an offset. */
function wallInZone(wall: string, zone: string): ParsedTime | null {
  const parsed = firstOccurrence(DateTime.fromISO(wall, { zone }));
  if (!parsed.isValid || parsed.toISO({ includeOffset: false }) !== wall || parsed.getPossibleOffsets().length !== 1) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

type ScanClock = FeedClock & { local_time?: string; provider_time_text?: string };

/**
 * `datetime_local` is the scan's local time although PostNL appends "Z": a
 * Swiss scan at 09:15 local arrives as "09:15Z". Each scan names its country,
 * except PostNL's own records: their Amsterdam (or UTC) reading is a guess,
 * kept only where it fits among the dated scans around it.
 */
function scanClock(event: JsonObject): ScanClock {
  const raw = text(event.datetime_local).trim().slice(0, 64);
  if (!raw) return {};
  if (PRECISE_UTC.test(raw)) return { known: explicitOffsetTime(raw), provider_time_text: raw };
  // The observed local-clock quirk uses Z. An unexpected nonzero offset
  // cannot be converted to UTC digits and assigned a second country offset.
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:?00)?$/.test(raw) ? mislabeledWallTime(raw) : null;
  if (!wall) return { provider_time_text: raw };
  const local = { local_time: wall.replace(/\.000$/, '') };
  const country = text(event.country_code).trim() || text(event.country_name).trim();
  if (!country) return { ...local, guesses: [wallInZone(wall, postnlRecordZone(eventCode(event.status)))] };
  const zone = countryTimeZone(country);
  // A country alone cannot distinguish mainland clocks from island clocks.
  return zone && !['Europe/Madrid', 'Europe/Lisbon'].includes(zone) ? { ...local, known: wallInZone(wall, zone) } : local;
}

/** Projects one `tracking-items` payload. Pure: the offline tests target this. */
export function parsePostNLTrackingResponse(value: unknown, trackingNumber: string, readAt = new Date()): CarrierResult {
  const payload = record(value);
  const rawItems = record(payload.data).items;
  if (!Array.isArray(rawItems)) {
    throw new SchemaError(PROVIDER, 'PostNL returned an invalid tracking response');
  }
  const items = recordArray(rawItems);
  if (items.length !== rawItems.length) {
    throw new SchemaError(PROVIDER, 'PostNL returned an invalid shipment entry');
  }
  if (items.length === 0) throw new SchemaError(PROVIDER, 'PostNL did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = items.filter((candidate) => comparableIdentifier(candidate.item));
  if (identified.length === 0) {
    throw new SchemaError(PROVIDER, 'PostNL did not return a shipment identifier');
  }
  const matches = identified.filter((candidate) => comparableIdentifier(candidate.item) === requested);
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'PostNL returned a different or ambiguous shipment');
  const item = matches[0]!;
  if (!Array.isArray(item.events)) {
    throw new SchemaError(PROVIDER, 'PostNL returned invalid tracking history');
  }
  const rawEvents = recordArray(item.events);
  if (rawEvents.length !== item.events.length) {
    throw new SchemaError(PROVIDER, 'PostNL returned an invalid tracking event');
  }
  if (rawEvents.length > 500) throw new SchemaError(PROVIDER, 'PostNL returned excessive tracking history');
  const message = text(item.message);
  if (rawEvents.length === 0 && NOT_FOUND_MESSAGE.test(message) && THREE_S.test(requested)) {
    // A 3S barcode sent within the Netherlands is only on the domestic tracker.
    throw new InputRequiredError(PROVIDER, 'postcode', DOMESTIC_MESSAGE);
  }
  if (rawEvents.length === 0 && (NOT_FOUND_MESSAGE.test(message) || (INCORRECT_MESSAGE.test(message) && READABLE_3S.test(requested)))) {
    // The rest of `message` can carry provider prose; only the recognized
    // phrase is used, and none of it reaches the error.
    throw new NotFoundError(PROVIDER);
  }
  // PostNL lists mail from abroad it does not hold yet the same way: an answer about the item, without scans.
  if (rawEvents.length === 0) throw new NoHistoryError(PROVIDER, 'PostNL lists the item without scans', { reason: 'listed' });
  const clocks = rawEvents.slice(0, 100).map(scanClock);
  const times = settleGuessedClocks(clocks, readAt.getTime());
  const events = rawEvents.slice(0, 100).map((event, index): CarrierEvent => {
    const code = eventCode(event.status);
    const classified = postNLStatus(event.category, event.status_description, code);
    const { local_time, provider_time_text } = clocks[index]!;
    return {
      ...(times[index] ? { time: times[index].iso } : local_time ? { local_time } : provider_time_text ? { provider_time_text } : {}),
      location: (text(event.country_name) || text(event.country_code)).slice(0, 200),
      description: (text(event.status_description) || text(event.category)).slice(0, 500),
      ...(code ? { provider_code: postNLCode(code, event.category) } : {}),
      ...(classified ? { stage: classified.stage } : {}),
    };
  });
  const latest = rawEvents[0] ?? {};
  const category = text(latest.category);
  const classified = postNLStatus(category, latest.status_description, eventCode(latest.status));
  const deliveredAt = classified?.status === 'delivered' ? events[0]?.time : null;
  const destination = text(item.destination_code).trim().toUpperCase();
  return {
    status: classified?.status ?? 'unknown',
    ...(classified ? { current_stage: classified.stage } : {}),
    last_status_text: (text(latest.status_description) || category).slice(0, 500),
    last_update: events[0]?.time || null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    events,
  };
}

/** A description as PostNL's domestic tracker writes it, without its stray spaces. */
function domesticText(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * The delivery estimate in the domestic reply's `eta`: a slot (`Specific`, start and end with
 * offsets), a day (`WholeDay`) or days (`MultipleDaySpan`, from the first day's midnight to the
 * last day's 23:59:59), read by their days as PostNL's calendar writes them. Other types with a
 * start or an end go to `unread_estimates`; `Unknown` comes without either. `minutesOverdue` is
 * the time since the slot's end when PostNL answers (34 at 14:09Z for a slot that ended at 13:35Z,
 * the driver still on the way), so it says nothing the slot does not; beside another type it is
 * unread.
 */
function domesticEstimate(collo: JsonObject): { estimate: WindowEstimate; unread: Pick<CarrierResult, 'unread_estimates'> } {
  const eta = record(collo.eta);
  const kind = text(eta.type).trim();
  const day = (value: unknown) => text(value).trim().slice(0, 10);
  const estimate = kind === 'Specific' ? windowEstimate(eta.start, eta.end)
    : kind === 'WholeDay' ? windowEstimate(null, eta.start)
      : kind === 'MultipleDaySpan' ? windowEstimate(day(eta.start), day(eta.end)) : { expected_delivery: null };
  // `Unknown` without a start or an end holds no estimate.
  const dated = [eta.start, eta.end].some((value) => text(value).trim());
  return { estimate, unread: unreadEstimates({ eta: estimate.expected_delivery || !dated ? null : collo.eta,
    'eta.minutesOverdue': estimate.expected_delivery ? null : eta.minutesOverdue }) };
}

/**
 * Projects one domestic tracker reply, keyed by barcode under `colli`. The
 * delivery is not among its observations: `isDelivered` says it happened and
 * `deliveryDate`, when present, when. The estimate holds until delivery, a
 * pick-up point or a return. Recipient, sender and route details are not read.
 * Pure: the offline tests target this.
 */
export function parsePostNLDomesticResponse(value: unknown, trackingNumber: string): CarrierResult {
  const colli = record(value).colli;
  if (!isRecord(colli)) throw new SchemaError(PROVIDER, 'PostNL returned an invalid domestic tracking response');
  const entries = Object.values(colli);
  // The tracker answers an unknown barcode and a wrong postcode alike.
  if (entries.length === 0) {
    throw new IndeterminateError(PROVIDER, 'PostNL found no parcel for that barcode and postcode', { reason: 'portal_not_found' });
  }
  const requested = comparableIdentifier(trackingNumber);
  const matches = entries.filter((entry) => isRecord(entry) && comparableIdentifier(entry.barcode) === requested);
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'PostNL returned a different or ambiguous shipment');
  const collo = matches[0] as JsonObject;
  const rawObservations = collo.observations ?? [];
  if (!Array.isArray(rawObservations)) throw new SchemaError(PROVIDER, 'PostNL returned invalid tracking history');
  const observations = recordArray(rawObservations);
  if (observations.length !== rawObservations.length) throw new SchemaError(PROVIDER, 'PostNL returned an invalid tracking event');
  if (observations.length > 500) throw new SchemaError(PROVIDER, 'PostNL returned excessive tracking history');
  const phase = record(collo.statusPhase);
  const phaseMessage = domesticText(phase.message);
  const scans = observations.slice(0, 100).map((observation) => {
    const description = domesticText(observation.description);
    const mapped = postNLDomesticStage(description);
    const classified: ClassifiedWording | null = mapped ? { stage: mapped, source: 'carrier_map' }
      : description ? classifyWording(description, 'in_transit') : null;
    return { observation, description, time: explicitOffsetTime(observation.observationDate),
      classified: classified?.source === 'none' ? null : classified };
  });
  // PostNL can receive the parcel again a day later, after its first receipt or a self-service drop-off and a notice
  // that reads in transit: a later receipt is a movement in its network, not a step back.
  for (const scan of scans) {
    const at = scan.time?.timestamp;
    if (scan.classified?.stage !== 'accepted' || at === undefined) continue;
    if (scans.some((other) => other.classified?.stage === 'accepted' && other.time !== null && other.time.timestamp < at)) {
      scan.classified = { stage: 'in_transit', source: 'carrier_map' };
    }
  }
  const delivered = collo.isDelivered === true;
  const deliveredAt = delivered ? explicitOffsetTime(collo.deliveryDate) : null;
  const { estimate, unread } = domesticEstimate(collo);
  // The observations come newest first; the delivery, when dated, ends them.
  if (deliveredAt) {
    scans.unshift({ observation: {}, description: phaseMessage || 'Delivered', time: deliveredAt, classified: { stage: 'delivered', source: 'carrier_map' } });
  }
  const latest = scans.reduce<(typeof scans)[number] | undefined>((newest, scan) => (
    !newest || (scan.time && (!newest.time || scan.time.timestamp > newest.time.timestamp)) ? scan : newest), undefined);
  if (!latest) {
    // An announced parcel PostNL has not received yet has no observations.
    if (phase.index !== 0 || !phaseMessage) throw new NoHistoryError(PROVIDER, 'PostNL lists the parcel without scans', { reason: 'listed' });
    return {
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: phaseMessage, last_update: null, ...estimate, ...unread, summary_only: true, events: [],
    };
  }
  const events = scans.map(({ observation, description, time, classified }): CarrierEvent => {
    const raw = text(observation.observationDate).trim().slice(0, 64);
    const code = text(observation.observationCode).trim();
    return {
      ...(time ? { time: time.iso } : raw ? { provider_time_text: raw } : {}),
      description,
      ...(/^[A-Z0-9]{1,8}$/i.test(code) ? { provider_code: code } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    };
  });
  // `isDelivered` decides: the phase already reads delivered while a parcel waits at a pick-up point.
  const current: ClassifiedWording | null = delivered ? { stage: 'delivered', source: 'carrier_map' } : latest.classified;
  const settled = delivered || collo.isAtRetailLocation === true
    || (current !== null && ['delivered', 'ready_for_pickup', 'returned'].includes(current.stage));
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: (delivered && phaseMessage) || latest.description || null,
    last_update: latest.time?.iso ?? null,
    ...(settled ? { expected_delivery: null } : { ...estimate, ...unread }),
    ...(deliveredAt ? { delivered_at: deliveredAt.iso } : {}),
    events,
  };
}

/**
 * PostNL's refusal of a request for being too many, with the number of tries the call made, how long they took and the
 * wait it asked for in its wording, so a host's log shows how often replays meet it and whether waiting longer would
 * have served the lookup.
 */
function rateLimited(error: UpstreamHttpError, tries: number, elapsedMs?: number): RateLimitedError {
  const wait = error.retryAfterMs === undefined ? 'without saying how long to wait'
    : `asking to wait ${Math.round(error.retryAfterMs / 1000)} s`;
  const attempt = tries <= 1 ? ' on the first try'
    : ` on each of ${tries} tries${elapsedMs === undefined ? '' : ` over ${Math.round(elapsedMs / 1000)} s`}`;
  return new RateLimitedError(PROVIDER, error.retryAfterMs,
    `${error.provider} refused the request with HTTP 429${tries > 0 ? attempt : ''}, ${wait}`, { cause: error, status: 429 });
}

/** Whether the caller, rather than the lookup's deadline, ended `signal`. */
function cancelled(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return signal.aborted && !(reason instanceof DOMException && reason.name === 'TimeoutError');
}

/** The wait a refusal names: its `Retry-After`, or else the end of the window `x-rate-limit-reset` gives as a date. */
function quotaWaitOf(headers: Headers): number | undefined {
  const reset = headers.get('x-rate-limit-reset')?.trim();
  return retryAfterMs(headers.get('retry-after')) ?? (reset && !/^\d+$/.test(reset) ? retryAfterMs(reset) : undefined);
}

/** A fetcher that counts the requests it makes, so a refusal can say which try met it. */
function counting(fetcher: typeof fetch | undefined): { fetcher: typeof fetch; tries: () => number } {
  let tries = 0;
  return {
    fetcher: (input, init) => {
      tries += 1;
      return (fetcher ?? fetch)(input, init);
    },
    tries: () => tries,
  };
}

/**
 * The country and postcode the domestic tracker's key ends with: a Dutch postcode without its
 * space, or another country's without spaces or hyphens. Null for a postcode without a country
 * that is not Dutch.
 */
function domesticAddress(postcode: string, country: string): string | null {
  if (!country || country === 'NL') {
    const dutch = DUTCH_POSTCODE.exec(postcode);
    return dutch ? `NL-${dutch[1]}${dutch[2]}` : null;
  }
  const compact = postcode.replace(/[\s-]+/g, '');
  return /^[A-Z]{2}$/.test(country) && FOREIGN_POSTCODE.test(compact) ? `${country}-${compact}` : null;
}

/** The same failure without the request details fetchBounded attaches: the address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

/**
 * PostNL's quota as one transport meets it: until when no tracking call goes out, and the turn of the lookup whose
 * calls go out now. The quota is shared with every visitor whatever their address, so the lookups that send through
 * one transport take turns, a call and its replays at a time, rather than replay into the same full minute; a call
 * every try of which was refused rests the others. A lookup that cannot wait for its turn or the rest within its time
 * fails as our own pacing (rate_limited, self_paced) with the wait, and sends nothing. A restart forgets it.
 */
interface PostNLQuota { restUntil: number; turn: Promise<void>; lookups: number }
const quotas = new WeakMap<object, PostNLQuota>();

/** Without a fetcher of its own, a lookup sends through the global fetch as it stands. */
function postNLQuota(fetcher: typeof fetch | undefined): PostNLQuota {
  const key = transportOf(fetcher) ?? globalThis.fetch;
  let quota = quotas.get(key);
  if (!quota) quotas.set(key, quota = { restUntil: 0, turn: Promise.resolve(), lookups: 0 });
  return quota;
}

function selfPaced(waitMs: number | undefined, message: string): RateLimitedError {
  return new RateLimitedError(PROVIDER, waitMs, message, { reason: 'self_paced' });
}

/** Whether `promise` settled before `ms` passed and `signal` ended. */
async function settledWithin(promise: Promise<unknown>, ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0 || signal.aborted) return false;
  const timer = new AbortController();
  const stop = () => timer.abort();
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([promise.then(() => true, () => true), paused(ms, timer.signal).then(() => false)]);
  } finally {
    signal.removeEventListener('abort', stop);
    timer.abort();
  }
}

export class PostNLTracker {
  private readonly fetcher: typeof fetch | undefined;
  private readonly now: () => Date;
  private readonly headers: Record<string, string>;
  private readonly userAgent: string;
  private readonly recorder: StepRecorder;

  /**
   * The visitor token this tracker's lookups share until shortly before it
   * expires. Each lasts a day, and the token endpoint's quota of 20 a minute
   * is shared beyond one client.
   */
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(options: { fetcher?: typeof fetch; now?: () => Date; userAgent?: string; recorder?: StepRecorder } = {}) {
    this.fetcher = options.fetcher;
    this.now = options.now ?? (() => new Date());
    this.userAgent = userAgentOf(options.userAgent);
    this.headers = siteHeaders(this.userAgent);
    this.recorder = options.recorder ?? NOOP_RECORDER;
  }

  /** The shared visitor token, or a new one once it is close to expiring. */
  private async visitorToken(signal: AbortSignal, deadline: number): Promise<{ value: string; reused: boolean }> {
    const requestedAt = this.now().getTime();
    if (this.cachedToken && requestedAt < this.cachedToken.expiresAt) return { value: this.cachedToken.value, reused: true };
    this.cachedToken = null;
    const counted = counting(this.fetcher);
    const { bytes } = await fetchBounded(
      TOKEN_URL,
      { method: 'POST', headers: this.headers, body: '{}', signal },
      {
        provider: 'PostNL authentication',
        timeoutMs: TOKEN_TIMEOUT_MS,
        maxBytes: 50_000,
        retryTransient: true,
        deadline,
        fetcher: counted.fetcher,
      },
    ).catch((error: unknown) => {
      throw error instanceof UpstreamHttpError && error.status === 429 ? rateLimited(error, counted.tries()) : error;
    });
    const reply = record(parseJsonBytes(bytes, 'PostNL authentication'));
    const accessToken = text(reply.access_token);
    if (!accessToken || accessToken.length > MAX_TOKEN_LENGTH) {
      throw new SchemaError(PROVIDER, 'PostNL returned an invalid visitor token');
    }
    // A token without a plausible lifetime serves this lookup only.
    const lifetimeMs = typeof reply.expires_in === 'number' && Number.isFinite(reply.expires_in)
      ? Math.min(reply.expires_in * 1000, MAX_TOKEN_LIFETIME_MS) : 0;
    if (lifetimeMs > TOKEN_RENEWAL_MARGIN_MS) {
      this.cachedToken = { value: accessToken, expiresAt: requestedAt + lifetimeMs - TOKEN_RENEWAL_MARGIN_MS };
    }
    return { value: accessToken, reused: false };
  }

  /**
   * The tracking request. A token PostNL refuses with HTTP 401 is not kept. A refusal as too many is replayed every
   * `QUOTA_PAUSE_MS`, and just after each wait PostNL named ends, while a try still fits before `deadline`: the last
   * pause shortens to fit, down to `MIN_QUOTA_PAUSE_MS`. A replay that fails or runs into the deadline leaves the
   * refusal standing; a caller's cancellation is reported as such.
   */
  private async track(trackingNumber: string, accessToken: string, signal: AbortSignal, deadline: number): Promise<Uint8Array> {
    const counted = counting(this.fetcher);
    const startedAt = performance.now();
    /** When each wait PostNL named ends, on `Date.now()`'s clock. */
    const expiries: number[] = [];
    let refusal: UpstreamHttpError | undefined;
    const standing = (current: UpstreamHttpError): RateLimitedError => {
      if (cancelled(signal)) signal.throwIfAborted();
      if (counted.tries() >= TRACKING_TRIES) {
        const quota = postNLQuota(this.fetcher);
        const now = Date.now();
        const pending = expiries.filter((expiry) => expiry > now);
        const rest = pending.length ? Math.min(...pending) - now : expiries.length ? QUOTA_PAUSE_MS : QUOTA_REST_MS;
        quota.restUntil = Math.max(quota.restUntil, now + Math.min(QUOTA_REST_MAX_MS, Math.max(QUOTA_PAUSE_MS, rest)));
      }
      return rateLimited(current, counted.tries(), performance.now() - startedAt);
    };
    for (;;) {
      let reply: { response: Response; bytes: Uint8Array };
      try {
        reply = await fetchBounded(
          TRACK_URL,
          {
            method: 'POST',
            headers: { ...this.headers, Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ items: [trackingNumber], language_code: 'en' }),
            signal,
          },
          {
            provider: 'PostNL tracking',
            // A replay ends before the lookup does, so the refusal it follows can still stand.
            timeoutMs: refusal ? Math.max(1, Math.min(TRACK_TIMEOUT_MS, Math.floor(deadline - performance.now() - 100))) : TRACK_TIMEOUT_MS,
            maxBytes: 1_000_000,
            retryTransient: counted.tries() === 0,
            allowHttpStatuses: [429],
            deadline,
            fetcher: counted.fetcher,
          },
        );
      } catch (error) {
        if (error instanceof UpstreamHttpError && error.status === 401 && this.cachedToken?.value === accessToken) this.cachedToken = null;
        if (refusal && !(error instanceof UpstreamHttpError && error.status === 401)) throw standing(refusal);
        throw error;
      }
      if (reply.response.status !== 429) return reply.bytes;
      refusal = new UpstreamHttpError('PostNL tracking', 429, quotaWaitOf(reply.response.headers));
      const now = Date.now();
      if (refusal.retryAfterMs !== undefined) expiries.push(now + refusal.retryAfterMs);
      const pending = expiries.filter((expiry) => expiry > now);
      const untilWaitEnds = pending.length ? Math.min(...pending) - now + WAIT_MARGIN_MS : Infinity;
      const pause = Math.min(QUOTA_PAUSE_MS, Math.max(MIN_QUOTA_PAUSE_MS, untilWaitEnds),
        deadline - REQUEST_RESERVE_MS - performance.now());
      if (pause < MIN_QUOTA_PAUSE_MS || !await paused(pause, signal)) throw standing(refusal);
    }
  }

  /** The domestic tracker's answer for a number and the country and postcode of its delivery address. */
  private async domestic(trackingNumber: string, address: string, signal: AbortSignal, timeoutMs: number, deadline: number): Promise<CarrierResult> {
    const key = `${encodeURIComponent(trackingNumber)}-${address}`;
    let bytes: Uint8Array;
    const counted = counting(this.fetcher);
    try {
      ({ bytes } = await fetchBounded(
        `${DOMESTIC_URL}/${key}?language=en`,
        { method: 'GET', headers: { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': this.userAgent }, signal },
        { provider: 'PostNL domestic tracking', timeoutMs, maxBytes: 1_000_000, retryTransient: true, deadline, fetcher: counted.fetcher },
      ));
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'PostNL domestic tracking is unavailable', { status: error.status });
      }
      const stripped = withoutPostcode(error);
      throw stripped instanceof UpstreamHttpError && stripped.status === 429 ? rateLimited(stripped, counted.tries()) : stripped;
    }
    signal.throwIfAborted();
    return parsePostNLDomesticResponse(parseJsonBytes(bytes, 'PostNL domestic tracking'), trackingNumber);
  }

  /** The international tracker's answer, with the visitor token it needs. */
  private async international(trackingNumber: string, signal: AbortSignal, deadline: number): Promise<CarrierResult> {
    const release = await this.turn(signal, deadline);
    try {
      const token = await this.visitorToken(signal, deadline);
      let bytes: Uint8Array;
      try {
        bytes = await this.track(trackingNumber, token.value, signal, deadline);
      } catch (error) {
        // A shared token PostNL no longer accepts is replaced once.
        if (!token.reused || !(error instanceof UpstreamHttpError) || error.status !== 401) throw error;
        bytes = await this.track(trackingNumber, (await this.visitorToken(signal, deadline)).value, signal, deadline);
      }
      signal.throwIfAborted();
      return parsePostNLTrackingResponse(parseJsonBytes(bytes, 'PostNL tracking'), trackingNumber, this.now());
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'PostNL tracking endpoint is unavailable', { cause: error });
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * This lookup's turn at PostNL's quota (`PostNLQuota`): once the lookups ahead have had theirs and any rest is over.
   * Gives the function that ends it.
   */
  private async turn(signal: AbortSignal, deadline: number): Promise<() => void> {
    const quota = postNLQuota(this.fetcher);
    const ahead = quota.turn;
    const waits = quota.lookups > 0;
    let resolve!: () => void;
    const mine = new Promise<void>((done) => { resolve = done; });
    quota.turn = ahead.then(() => mine);
    quota.lookups += 1;
    let ended = false;
    const release = () => {
      if (ended) return;
      ended = true;
      quota.lookups -= 1;
      resolve();
    };
    try {
      if (waits && !await settledWithin(ahead, deadline - performance.now() - TURN_RESERVE_MS, signal)) {
        signal.throwIfAborted();
        throw selfPaced(QUOTA_PAUSE_MS * TRACKING_TRIES, 'PostNL is being asked for another parcel; no request until its turn ends');
      }
      const rest = quota.restUntil - Date.now();
      if (rest > 0) {
        const message = 'PostNL refused every try of a recent request; no request until its quota frees up';
        if (rest > deadline - performance.now() - TURN_RESERVE_MS) throw selfPaced(rest, message);
        if (!await paused(rest, signal)) signal.throwIfAborted();
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}, postcode?: string | null, country?: string | null): Promise<CarrierResult> {
    const budget = context.budgetMs ?? LOOKUP_TIMEOUT_MS;
    if (!Number.isFinite(budget) || budget <= 0) throw new TypeError('PostNL timeout must be positive');
    const supplied = postcode?.trim().toUpperCase() ?? '';
    const address = supplied ? domesticAddress(supplied, country?.trim().toUpperCase() ?? '') : null;
    const domestic = domesticNumber(comparableIdentifier(trackingNumber)) && address !== null;
    return runSteps({ carrier: 'spring-gds', budgetMs: budget, signal: context.signal, recorder: this.recorder }, [
      {
        id: 'domestic',
        enabled: domestic,
        // Half of the budget at most, so the international tracker can still be asked.
        run: ({ signal, remainingMs }) => this.domestic(trackingNumber, address!, signal,
          Math.max(1, Math.floor(Math.min(DOMESTIC_TIMEOUT_MS, remainingMs / 2))), performance.now() + remainingMs),
      },
      {
        id: 'direct',
        // The international tracker shows parcels the domestic one does not.
        recovers: () => true,
        run: async ({ signal, remainingMs, previousError }) => {
          try {
            return await this.international(trackingNumber, signal, performance.now() + remainingMs);
          } catch (error) {
            if (!(error instanceof InputRequiredError) || !supplied) throw error;
            if (!address) {
              throw new InputRequiredError(PROVIDER, 'postcode', 'PostNL\'s domestic tracker takes a Dutch delivery postcode, or another country\'s with that country', { reason: 'postcode_mismatch' });
            }
            // The domestic tracker's own failure, unless it found nothing either.
            if (previousError instanceof CarrierError && !(previousError instanceof IndeterminateError && previousError.reason === 'portal_not_found')) {
              throw previousError;
            }
            throw new IndeterminateError(PROVIDER, 'PostNL found no parcel for that barcode and postcode', { reason: 'portal_not_found' });
          }
        },
      },
    ]);
  }
}

/** Kept for the host's legacy dispatch chain until it is deleted. */
export async function fetchPostNL(trackingNumber: string): Promise<CarrierResult> {
  return new PostNLTracker().fetch(trackingNumber);
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostNLTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return {
    id: 'spring-gds',
    recordsSteps: true,
    // The domestic tracker runs only for a 3S barcode or a valid S10 number with a postcode it can take. The
    // international visitor token and lookup are one step: both are keyless HTTP
    // on the same host, and each replays inside the step, the tracking call after a 429 until the step's deadline.
    steps: ['domestic', 'direct'],
    track: (input, context) => tracker.fetch(input.number, context, input.postcode, input.postcodeCountry),
    // Only the series the catalog's recognition pattern names: a 3S barcode PostNL
    // does not find may still be on the domestic tracker, behind a postcode.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => RECOGNIZED.test(comparableIdentifier(number))),
  };
};
