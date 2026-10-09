/**
 * DHL eCommerce, through its anonymous Americas Webtrack API first, then
 * the global tracking page's UTAPI for shipments outside Webtrack's scope.
 *
 * DHL may answer with a customer-confirmation id instead of the queried
 * alias, so only one eCommerce shipment from that exact request URL is
 * accepted, and the id itself is never retained.
 */

import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, type CarrierErrorOptions } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import { countryTimeZone } from '../../core/time/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean as cleanText, fetchBounded, parseJsonBytes, UpstreamHttpError, UpstreamNetworkError, userAgentOf } from '../../core/transport/index.js';
import { scrapeUniversalPage, type UniversalBrowserOptions } from '../../core/transport/browser.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { stageFor, statusFor } from './status.js';

const PROVIDER = 'DHL eCommerce';
const API = 'https://www.dhl.com/utapi';
const WEBTRACK_API = 'https://api.dhlecs.com/webtrack/v4/tracking';
const DIRECT_TIMEOUT_MS = 15_000;
/** Statuses DHL answers with while its challenge is unsolved. */
const CHALLENGE_STATUSES = [401, 403, 419, 428];

function browserRecoveryAllowed(error: unknown): boolean {
  return error instanceof ChallengeError || error instanceof UpstreamNetworkError
    || error instanceof UpstreamHttpError && error.status >= 500
    || error instanceof IndeterminateError && ['webtrack_not_found', 'webtrack_no_history'].includes(error.reason ?? '');
}

/**
 * UTAPI strings occasionally carry markup. Tags are dropped without a
 * separator, as this adapter has always done, before the shared cleaner
 * collapses whitespace and caps the length.
 */
function clean(value: unknown, limit = 500): string {
  return typeof value === 'string' ? cleanText(value.replace(/<[^>]*>/g, ''), limit) : '';
}

function cleanNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, '');
}

/**
 * The number DHL is asked for. A USPS routing barcode opens with the
 * recipient's ZIP code; Webtrack also knows the package by the identifier
 * after it, so only that identifier is sent, and a barcode without a single
 * one is not sent at all.
 */
export function normalizeDHLEcommerceNumber(raw: string): string {
  const number = cleanNumber(raw);
  if (!/^(?=.*\d)[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'DHL eCommerce tracking number is invalid');
  if (!USPS_ROUTING_BARCODE.test(number)) return number;
  const pic = uspsPackageIdentifier(number);
  if (!pic) throw new InvalidInputError(PROVIDER, 'A USPS routing barcode without a single package identifier is not sent');
  return pic;
}

export function dhlEcommerceTrackingUrl(number: string): string {
  return `https://www.dhl.com/ch-en/home/tracking.html?tracking-id=${normalizeDHLEcommerceNumber(number)}&submit=1`;
}

function address(event: JsonObject): JsonObject {
  const location = isRecord(event.location) ? event.location : {};
  return isRecord(location.address) ? location.address : {};
}

// UTAPI returns local wall-clock timestamps, sometimes without countryCode.
// Resolve only unambiguous locations; never treat an unknown local time as UTC.
const HUB_ZONES: Record<string, string> = {
  'melrose park, il, us': 'America/Chicago', 'hebron, ky, us': 'America/New_York',
  'lahr': 'Europe/Berlin', 'staufenberg': 'Europe/Berlin',
};

/**
 * A local policy rather than one from `core/time`: the zone comes from the
 * event's own location, and every event is normalized to UTC because the
 * result declares `timezone: 'UTC'` for a carrier whose legs cross zones.
 */
function eventTime(event: JsonObject): string | null {
  const raw = clean(event.timestamp, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  const place = address(event);
  const locality = clean(place.addressLocality, 160);
  const country = clean(place.countryCode).toUpperCase();
  const zone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? 'UTC'
    : countryTimeZone(country) ?? countryTimeZone(locality) ?? HUB_ZONES[locality.toLowerCase()];
  if (!zone) return null;
  const parsed = DateTime.fromISO(raw, { zone, setZone: true });
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

/** Only call for the response to the exact requested UTAPI URL. DHL can return
 * a customer-confirmation id which differs from every queried parcel alias. */
export function parseDHLEcommerceResponse(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.shipments)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned an invalid tracking response');
  if (payload.shipments.length !== 1 || !isRecord(payload.shipments[0])) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce did not return one unambiguous shipment');
  }
  const shipment = payload.shipments[0];
  if (!clean(shipment.id)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned a shipment without an identifier');
  if (shipment.service !== 'ecommerce') throw new SchemaError(PROVIDER, 'This shipment is not handled by DHL eCommerce');
  if (!isRecord(shipment.status) || !clean(shipment.status.description)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned no tracking status');
  if (!Array.isArray(shipment.events) || shipment.events.length > 500) throw new SchemaError(PROVIDER, 'DHL eCommerce returned invalid tracking events');
  const events: CarrierEvent[] = shipment.events.filter(isRecord).flatMap((event) => {
    const time = eventTime(event);
    const description = clean(event.description);
    if (!time || !description) return [];
    const place = address(event);
    const stage = stageFor(event);
    return [{ time, description: stage === 'delivered' ? 'Delivered' : description,
      location: [...new Set([clean(place.addressLocality, 160), clean(place.countryCode, 2)].filter(Boolean))].join(', '),
      stage }];
  }).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 100);
  const stage = shipment.returnFlag === true && shipment.status.statusCode === 'delivered'
    ? 'returned' : stageFor(shipment.status);
  const expected = clean(shipment.estimatedTimeOfDelivery, 64).slice(0, 10);
  const sender = clean(
    isRecord(shipment.sender) ? shipment.sender.name : shipment.senderName, 200,
  ) || null;
  const deliveredAt = stage === 'delivered' ? eventTime(shipment.status) : null;
  return {
    status: statusFor(stage), current_stage: stage,
    last_status_text: stage === 'delivered' ? 'Delivered' : clean(shipment.status.description),
    last_update: eventTime(shipment.status),
    expected_delivery: !['delivered', 'returned'].includes(stage) && /^\d{4}-\d{2}-\d{2}$/.test(expected)
      && DateTime.fromISO(expected).isValid ? expected : null,
    timezone: 'UTC', events,
    ...(sender ? { sender_name: sender } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
  };
}

function webtrackClock(event: JsonObject): { time?: string; local_time?: string } | null {
  const date = clean(event.date, 32);
  const time = clean(event.time, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(time)) return null;
  const raw = `${date}T${time}`;
  if (!DateTime.fromISO(raw, { zone: 'UTC', setZone: true }).isValid) return null;
  const location = clean(event.location, 160);
  const country = location.split(',').at(-1)?.trim().toUpperCase() ?? '';
  const instant = eventTime({ timestamp: raw, location: { address: {
    addressLocality: location, ...(/^[A-Z]{2}$/.test(country) ? { countryCode: country } : {}),
  } } });
  return instant ? { time: instant } : { local_time: raw };
}

/** Webtrack scopes the read to the requested alias and returns that alias on
 * each package, as its own client requires. An alias can differ from all of
 * the package's carrier identifiers, so accept it only on one identified,
 * unambiguous package. Never accept a bare query echo or a fabricated shell. */
export function parseDHLEcommerceWebtrackResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeDHLEcommerceNumber(trackingNumber);
  if (!isRecord(payload) || !Array.isArray(payload.packages) || !Number.isInteger(payload.total)
    || Number(payload.total) < 0 || payload.packages.length > 50 || payload.offset !== 0
    || (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned an invalid Webtrack response');
  }
  if (payload.total === 0 && payload.packages.length === 0) {
    // Webtrack covers the Americas network; the global endpoint may still
    // know an item this regional endpoint does not list.
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce Webtrack does not list this shipment', { reason: 'webtrack_not_found' });
  }
  if (payload.total !== 1 || payload.packages.length !== 1 || !isRecord(payload.packages[0])) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce did not return one unambiguous Webtrack package');
  }
  const shipment = payload.packages[0];
  const identifiers = [shipment.trackingId, shipment.packageId, shipment.dhlPackageId, shipment.deliveryConfirmationNumber];
  const matches = (value: unknown) => typeof value === 'string'
    && value.toUpperCase().replace(/[\s.-]/g, '') === number;
  if (!clean(shipment.tmiUid) || !identifiers.some((value) => clean(value))
    || ![shipment.trackedValue, ...identifiers].some(matches)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned a different or unidentified Webtrack package');
  }
  const summary = clean(shipment.status);
  if (!summary || !Array.isArray(shipment.events) || shipment.events.length > 500
    || shipment.events.some((event) => !isRecord(event))) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned invalid Webtrack tracking history');
  }
  const events: CarrierEvent[] = shipment.events.flatMap((event: JsonObject) => {
    const description = clean(event.primaryEventDescription);
    const clock = webtrackClock(event);
    if (!description || !clock) return [];
    const stage = stageFor({ description });
    return [{ ...clock, description: stage === 'delivered' ? 'Delivered' : description,
      location: clean(event.location, 160), stage }];
  }).sort((left, right) => left.time && right.time ? right.time.localeCompare(left.time) : 0).slice(0, 100);
  const summaryStage = stageFor({ description: summary, statusCode: summary === 'Delivered' ? 'delivered' : undefined });
  // A published scan carries finer semantics than Webtrack's coarse summary.
  const stage = ['delivered', 'returned'].includes(summaryStage) ? summaryStage : events[0]?.stage ?? summaryStage;
  if (events.length === 0) {
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce has not published Webtrack tracking history', { reason: 'webtrack_no_history' });
  }
  const expected = clean(shipment.estimatedDeliveryDate, 32);
  const sender = clean(isRecord(shipment.sender) ? shipment.sender.name : null, 200);
  return {
    status: statusFor(stage), current_stage: stage,
    last_status_text: stage === 'delivered' ? 'Delivered' : summary,
    last_update: events.find((event) => event.time)?.time ?? null,
    expected_delivery: !['delivered', 'returned'].includes(stage) && /^\d{4}-\d{2}-\d{2}$/.test(expected)
      && DateTime.fromISO(expected).isValid ? expected : null,
    timezone: 'UTC', events,
    ...(sender ? { sender_name: sender } : {}),
    ...(stage === 'delivered' && events[0]?.stage === 'delivered' && events[0].time ? { delivered_at: events[0].time } : {}),
  };
}

/**
 * The tracking page answered with a challenge status instead of the tracking
 * application. The name is part of the host's error metadata contract: it
 * reports the upstream status for errors named `DHLEcommerceSessionError`.
 */
export class DHLEcommerceSessionError extends ChallengeError {
  /** Always present here; narrowed from the optional base field. */
  declare readonly status: number;

  constructor(status: number, options?: CarrierErrorOptions) {
    super(PROVIDER, `DHL eCommerce rejected the tracking session with HTTP ${status}`, { ...options, status });
    this.name = 'DHLEcommerceSessionError';
  }
}

function trackingApiUrl(number: string): string {
  const url = new URL(API);
  url.search = new URLSearchParams({ trackingNumber: number, language: 'en', requesterCountryCode: 'CH', source: 'tt' }).toString();
  return url.toString();
}

export interface DHLEcommerceTrackerOptions extends Omit<UniversalBrowserOptions, 'signal'> {
  budgetMs?: number;
  recorder?: StepRecorder;
  fetcher?: typeof fetch;
  userAgent?: string;
}

/**
 * The package identifier of a typed routing barcode is the number DHL was
 * asked for, and the one USPS tracks, so consumers can keep that.
 */
function withPackageIdentifier(typed: string, number: string, result: CarrierResult): CarrierResult {
  return cleanNumber(typed) !== number ? { ...result, canonical_tracking_number: number } : result;
}

export class DHLEcommerceTracker {
  private readonly recorder: StepRecorder;
  private readonly serialize = singleFlight();

  constructor(readonly options: DHLEcommerceTrackerOptions = {}) {
    const timeout = options.timeoutMs;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000)) {
      throw new TypeError('DHL eCommerce timeout must be between 1 and 60000 ms');
    }
    this.recorder = options.recorder ?? NOOP_RECORDER;
  }

  /** One browser at a time per instance: a batch must not spawn a Chromium per parcel. */
  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDHLEcommerceNumber(trackingNumber);
    const timeoutMs = this.options.timeoutMs ?? 45_000;
    const result = await takeTurn(this.serialize, PROVIDER, context, ({ signal, budgetMs }) => runSteps<CarrierResult>(
      { carrier: 'dhl-ecommerce', budgetMs: budgetMs ?? this.options.budgetMs ?? timeoutMs + 15_000, signal, recorder: this.recorder },
      [
        { id: 'direct', run: (step) => this.direct(number, Math.min(DIRECT_TIMEOUT_MS, step.remainingMs), step.signal) },
        { id: 'browser', recovers: browserRecoveryAllowed,
          run: (step) => this.browser(number, Math.max(1, Math.floor(Math.min(timeoutMs, step.remainingMs))), step.signal) },
      ],
    ));
    return withPackageIdentifier(trackingNumber, number, result);
  }

  /** Recognition never starts the global page or spends a browser budget. */
  async recognize(trackingNumber: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(async () => {
      const number = normalizeDHLEcommerceNumber(trackingNumber);
      const budget = lookupBudget(context, DIRECT_TIMEOUT_MS, PROVIDER);
      try {
        return await this.direct(number, Math.min(DIRECT_TIMEOUT_MS, budget.remainingMs()), budget.signal);
      } catch (error) {
        // A clean regional miss is unknown to this recognition check; it is
        // never a claim that the global DHL network does not know the number.
        if (error instanceof IndeterminateError && error.reason === 'webtrack_not_found') throw new NotFoundError(PROVIDER);
        throw error;
      }
    }, () => accepted(() => normalizeDHLEcommerceNumber(trackingNumber)));
  }

  private async direct(number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    try {
      const { response, bytes } = await fetchBounded(WEBTRACK_API, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ trackedValue: number, offset: 0, locale: 'en-US' }),
      }, { provider: PROVIDER, timeoutMs, maxBytes: 1_000_000, fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
      if (!response.ok) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Webtrack endpoint is unavailable');
      return parseDHLEcommerceWebtrackResponse(parseJsonBytes(bytes, PROVIDER), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && CHALLENGE_STATUSES.includes(error.status)) {
        throw new DHLEcommerceSessionError(error.status, { cause: error });
      }
      throw error;
    }
  }

  private async browser(number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    try {
      return await scrapeUniversalPage({ executablePath: this.options.executablePath, timeoutMs, signal }, {
        name: PROVIDER, url: dhlEcommerceTrackingUrl(number), responseUrl: trackingApiUrl(number),
      }, parseDHLEcommerceResponse);
    } catch (error) {
      // The challenge can also reach the page itself; name it so the host
      // records the upstream status rather than a bare transport failure.
      if (error instanceof UpstreamHttpError && CHALLENGE_STATUSES.includes(error.status)) {
        throw new DHLEcommerceSessionError(error.status, { cause: error });
      }
      throw error;
    }
  }

  async recognizeWithBrowser(number: string, context: TrackingContext = {}, previousError?: unknown) {
    if (previousError !== undefined && !browserRecoveryAllowed(previousError)) {
      throw previousError instanceof Error ? previousError : new Error('DHL eCommerce HTTP recognition cannot recover through a browser');
    }
    const normalized = normalizeDHLEcommerceNumber(number);
    return takeTurn(this.serialize, PROVIDER, context, (step) => recognizeFromBrowserLookup(async () => withPackageIdentifier(number, normalized,
      await runSteps<CarrierResult>(
        { carrier: 'dhl-ecommerce', budgetMs: step.budgetMs ?? 20_000, signal: step.signal, recorder: this.recorder },
        [{ id: 'browser', run: ({ signal, remainingMs }) => this.browser(normalized, remainingMs, signal) }],
      ))));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DHLEcommerceTracker({
    executablePath: environment.browserExecutablePath ?? undefined, recorder: environment.recorder,
    fetcher: environment.fetcher, userAgent: environment.userAgent,
  });
  return {
    id: 'dhl-ecommerce', recordsSteps: true,
    steps: ['direct', 'browser'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
    recognizeWithBrowser: (number, context, previousError) => tracker.recognizeWithBrowser(number, context, previousError),
  };
};
