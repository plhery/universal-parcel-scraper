import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type AdapterEnvironment, type TrackingContext } from '../../core/adapter/index.js';
import { isValidDhlExpressWaybill } from '../../core/detection/numericChecksums.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { facilityZone } from './clock.js';
import { DhlMobileApi } from './mobile.js';
import { dhlExpressStage } from './status.js';

const PROVIDER = 'DHL Express';
const BROWSER_API = 'https://www.dhl.com/utapi';
const MAX_BYTES = 1_000_000;
// The scoped browser runner bounds context cleanup to 1.5 seconds. Leave room
// for that and transport without consuming most of a short recognition budget.
const BROWSER_CLEANUP_ALLOWANCE_MS = 2_000;

export function normalizeNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  if (!isValidDhlExpressWaybill(number)) {
    throw new InvalidInputError(PROVIDER, 'DHL Express requires a 10-digit waybill with a valid check digit');
  }
  return number;
}

export function trackingUrl(raw: string): string {
  return `https://mydhl.express.dhl/gb/en/tracking.html#/results?id=${normalizeNumber(raw)}`;
}

const CLOCK_FORMAT = 'cccc, MMMM dd, yyyy HH:mm';

/**
 * MyDHL clocks are local to each facility and carry no UTC offset. A scan is
 * dated only when its facility's zone is known; any other keeps its clock.
 */
function clock(date: unknown, time: unknown, location: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (typeof date !== 'string' || typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) return {};
  const wall = `${date} ${time}`;
  const local = DateTime.fromFormat(wall, CLOCK_FORMAT, { locale: 'en', zone: 'utc' });
  if (!local.isValid) return {};
  const zone = facilityZone(location);
  const instant = zone ? zonedTime(wall, CLOCK_FORMAT, zone, { locale: 'en' }) : null;
  return instant ? { time: instant.iso } : { local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/** Public DHL web tracking: bind both the waybill and the Express division. */
export function parseUnified(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.shipments) || payload.shipments.length > 20
    || payload.shipments.some((shipment) => !isRecord(shipment))) throw new SchemaError(PROVIDER, 'DHL returned invalid shipments');
  const matching = payload.shipments.filter(isRecord).filter((shipment) => shipment.id === number);
  if (!matching.length) throw new SchemaError(PROVIDER, 'DHL returned a different waybill');
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'DHL returned a reused waybill');
  const shipment = matching[0]!;
  if (shipment.service !== 'express') throw new IndeterminateError(PROVIDER, 'DHL returned a different division');
  if (!Array.isArray(shipment.events) || shipment.events.length > 1000) throw new SchemaError(PROVIDER, 'DHL returned invalid events');
  if (!shipment.events.length) throw new IndeterminateError(PROVIDER, 'DHL has no shipment activity');
  const event = (row: unknown): CarrierEvent => {
    if (!isRecord(row) || typeof row.description !== 'string' || !row.description.trim()) throw new SchemaError(PROVIDER, 'DHL returned an invalid event');
    const description = row.statusCode === 'delivered' ? 'Delivered' : clean(row.description).slice(0, 1000);
    const mapped = dhlExpressStage(description);
    const time = typeof row.timestamp === 'string' && /(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.test(row.timestamp)
      ? explicitOffsetTime(row.timestamp)?.iso : undefined;
    const address = isRecord(row.location) && isRecord(row.location.address) ? row.location.address : {};
    return { description, stage: mapped.stage, stage_source: mapped.source,
      ...(time ? { time } : {}), ...(typeof address.addressLocality === 'string' ? { location: clean(address.addressLocality).slice(0, 300) } : {}),
      ...(typeof row.status === 'string' ? { provider_code: row.status.slice(0, 100) } : {}) };
  };
  const events = shipment.events.map(event);
  const current = event(shipment.status);
  const status: CarrierStatus = current.stage === 'delivered' ? 'delivered' : current.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['exception', 'failed_attempt', 'returned'].includes(current.stage!) ? 'exception'
      : ['pending', 'registered'].includes(current.stage!) ? 'pending' : 'in_transit';
  const destination = isRecord(shipment.destination) && isRecord(shipment.destination.address) ? shipment.destination.address : {};
  return { status, current_stage: current.stage, current_stage_source: current.stage_source,
    last_status_text: current.description, last_update: current.time ?? null, events,
    ...(typeof destination.countryCode === 'string' && /^[A-Z]{2}$/.test(destination.countryCode) ? { destination_country: destination.countryCode } : {}) };
}

/** A waybill can be reused. Multiple or duplicate shipments need recipient disambiguation. */
export function parse(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNumber(raw);
  if (isRecord(payload) && payload.results === undefined && Array.isArray(payload.errors) && payload.errors.length === 1
    && isRecord(payload.errors[0]) && payload.errors[0].id === number && payload.errors[0].code === 404
    && payload.errors[0].label === 'Not found') throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > 20 || payload.results.some((r) => !isRecord(r))) {
    throw new SchemaError(PROVIDER, 'DHL Express returned invalid tracking results');
  }
  const matching = payload.results.filter(isRecord).filter((r) => r.id === number);
  if (!matching.length) throw new SchemaError(PROVIDER, 'DHL Express returned a different waybill');
  if (matching.length > 1) throw new IndeterminateError(PROVIDER, 'DHL Express returned a reused waybill');
  const shipment = matching[0]!;
  if (shipment.duplicate === true || shipment.hasDuplicateShipment === true) throw new IndeterminateError(PROVIDER, 'DHL Express returned a reused waybill');
  if (!Array.isArray(shipment.checkpoints) || shipment.checkpoints.length > 1000) throw new SchemaError(PROVIDER, 'DHL Express returned invalid checkpoints');
  if (!shipment.checkpoints.length) throw new IndeterminateError(PROVIDER, 'DHL Express has no shipment activity');
  const events: CarrierEvent[] = shipment.checkpoints.map((row) => {
    if (!isRecord(row) || typeof row.description !== 'string' || !row.description.trim()) throw new SchemaError(PROVIDER, 'DHL Express returned an invalid checkpoint');
    const description = clean(row.description).slice(0, 1000);
    const mapped = dhlExpressStage(description);
    const location = typeof row.location === 'string' ? clean(row.location).slice(0, 300) : '';
    return { description, ...clock(row.date, row.time, location), ...(typeof row.location === 'string' ? { location } : {}),
      stage: mapped.stage, stage_source: mapped.source };
  });
  const current = events[0]!;
  const status: CarrierStatus = current.stage === 'delivered' ? 'delivered' : current.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['exception', 'failed_attempt', 'returned'].includes(current.stage!) ? 'exception'
      : ['pending', 'registered'].includes(current.stage!) ? 'pending' : 'in_transit';
  return { status, current_stage: current.stage, current_stage_source: current.stage_source,
    last_status_text: current.description, last_update: current.time ?? null,
    ...(typeof current.local_time === 'string' ? { last_update_local: current.local_time } : {}), events,
    ...(typeof shipment.consigneeCountryCode === 'string' && /^[A-Z]{2}$/.test(shipment.consigneeCountryCode)
      ? { destination_country: shipment.consigneeCountryCode } : {}) };
}

/** Guest mobile history has facility-local clocks and orders scans by counter. */
export function parseMobile(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNumber(raw);
  if (!Array.isArray(payload) || payload.length > 20 || payload.some((shipment) => !isRecord(shipment))) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid shipments');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  const shipments = payload.filter(isRecord).map((shipment) => {
    if (!Array.isArray(shipment.checkpoints) || shipment.checkpoints.length > 1000) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid checkpoints');
    const counters = new Set<number>();
    const checkpoints = shipment.checkpoints.map((row) => {
      if (!isRecord(row) || typeof row.counter !== 'number' || !Number.isSafeInteger(row.counter) || row.counter < 1 || counters.has(row.counter)) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned an invalid checkpoint counter');
      counters.add(row.counter);
      return { ...row, counter: row.counter, date: typeof row.date_en === 'string' ? row.date_en : row.date };
    }).sort((a, b) => b.counter - a.counter);
    return { ...shipment, checkpoints };
  });
  return parse({ results: shipments }, number);
}

export class DhlExpressTracker {
  private readonly mobile: DhlMobileApi;
  constructor(private readonly environment: AdapterEnvironment) {
    this.mobile = new DhlMobileApi(environment);
  }

  async direct(number: string, context?: TrackingContext): Promise<CarrierResult> {
    const normalized = normalizeNumber(number);
    const budget = lookupBudget(context, 10_000, PROVIDER);
    return parseMobile(await this.mobile.tracking(normalized, budget), normalized);
  }

  async browser(number: string, context?: TrackingContext): Promise<CarrierResult> {
    const budget = lookupBudget(context, 45_000, PROVIDER);
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'DHL Express requires the browser tracking service');
    const timeoutMs = budget.remainingMs() - BROWSER_CLEANUP_ALLOWANCE_MS;
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, budget.budgetMs);
    const page = await this.environment.trawl.scrape({ url: `https://www.dhl.com/global-en/home/tracking/tracking-parcel.html?submit=1&tracking-id=${normalizeNumber(number)}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [BROWSER_API], settleTimeout: timeoutMs,
    }, { provider: PROVIDER, timeoutMs, signal: budget.signal, maxBytes: 6_000_000, requireSolved: false });
    budget.signal.throwIfAborted();
    const captures = page.capturedResponses.filter((r) => {
      try { const url = new URL(r.url); return url.origin + url.pathname === BROWSER_API && !url.username && !url.password
        && url.searchParams.getAll('trackingNumber').length === 1 && url.searchParams.get('trackingNumber') === number && r.status !== 204; }
      catch { return false; }
    });
    const response = captures.at(-1);
    if (!response || captures.length > 10 || response.error || response.truncated || response.base64Encoded) {
      throw new TransportError(PROVIDER, 'DHL Express returned no complete matching browser response');
    }
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403, 428].includes(response.status) || /^\s*</.test(response.body ?? '')) throw new ChallengeError(PROVIDER);
    if (response.status === 404 && response.body) {
      let missing: unknown;
      try { missing = JSON.parse(response.body); } catch { /* An arbitrary 404 is not a shipment answer. */ }
      if (isRecord(missing) && missing.status === 404 && missing.title === 'No result found'
        && missing.detail === 'No shipment with given tracking number found.') throw new NotFoundError(PROVIDER);
    }
    if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.body === null) throw new TransportError(PROVIDER, 'DHL Express returned no complete matching browser response');
    if (response.status !== 200 || Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'DHL Express returned invalid browser data');
    return parseUnified(parseJsonBytes(new TextEncoder().encode(response.body), PROVIDER), number);
  }

  fetch(raw: string, context?: TrackingContext): Promise<CarrierResult> {
    const number = normalizeNumber(raw);
    return runSteps({ carrier: 'dhl-express', budgetMs: context?.budgetMs ?? 45_000, signal: context?.signal, recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: Math.min(remainingMs, 10_000) }) },
      { id: 'trawl', enabled: !!this.environment.trawl, run: ({ signal, remainingMs }) => this.browser(number, { signal, budgetMs: remainingMs }) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlExpressTracker(environment);
  return { id: 'dhl-express', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.direct(number, context), () => accepted(() => normalizeNumber(number))),
    recognizeWithBrowser: async (number, context, previousError) => {
      if (previousError instanceof RateLimitedError || previousError instanceof SchemaError || previousError instanceof NotFoundError) throw previousError;
      return recognizeFromBrowserLookup(() => tracker.browser(normalizeNumber(number), context));
    } };
};
