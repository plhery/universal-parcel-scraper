import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type AdapterEnvironment, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { classifyWording, type Stage } from '../../core/status/index.js';
import { clean, decodeText, fetchBounded, parseJsonBytes, TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'DHL Express';
const API = 'https://mydhl.express.dhl/shipmentTracking';
const MAX_BYTES = 1_000_000;

export function normalizeNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  // The public MyDHL+ tracking bundle validates the last digit as the first nine modulo seven.
  if (!/^\d{10}$/.test(number) || Number(number.slice(0, 9)) % 7 !== Number(number[9])) {
    throw new InvalidInputError(PROVIDER, 'DHL Express requires a 10-digit waybill with a valid check digit');
  }
  return number;
}

export function trackingUrl(raw: string): string {
  return `https://mydhl.express.dhl/gb/en/tracking.html#/results?id=${normalizeNumber(raw)}`;
}

function apiUrl(number: string): string {
  return `${API}?${new URLSearchParams({ AWB: number, clientApp: 'mydhlplus', countryCode: 'gb', languageCode: 'en',
    requestAdditionalDetails: 'controlledAccessDataCodes,productCode,shipmentActivationDate,countryCodes' })}`;
}

/** MyDHL clocks are local to each facility; they do not carry a UTC offset. */
function clock(date: unknown, time: unknown): string | undefined {
  if (typeof date !== 'string' || typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  const parsed = DateTime.fromFormat(`${date} ${time}`, 'cccc, MMMM dd, yyyy HH:mm', { locale: 'en', zone: 'utc' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function stage(description: string): { stage: Stage; source: string } {
  const text = description.toLowerCase();
  if (text === 'delivered') return { stage: 'delivered', source: 'carrier_map' };
  if (text === 'shipment is out with courier for delivery') return { stage: 'out_for_delivery', source: 'carrier_map' };
  if (text.startsWith('delivery attempted')) return { stage: 'failed_attempt', source: 'carrier_map' };
  if (text === 'shipment is on hold') return { stage: 'exception', source: 'carrier_map' };
  if (text === 'shipment picked up') return { stage: 'accepted', source: 'carrier_map' };
  if (text.startsWith('clearance processing') || text.startsWith('customs clearance')) return { stage: 'customs', source: 'carrier_map' };
  return classifyWording(description, 'pending');
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
    const mapped = stage(description);
    return { description, ...(clock(row.date, row.time) ? { time: clock(row.date, row.time) } : {}),
      ...(typeof row.location === 'string' ? { location: clean(row.location).slice(0, 300) } : {}),
      stage: mapped.stage, stage_source: mapped.source };
  });
  const current = events[0]!;
  const status: CarrierStatus = current.stage === 'delivered' ? 'delivered' : current.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['exception', 'failed_attempt', 'returned'].includes(current.stage!) ? 'exception'
      : ['pending', 'registered'].includes(current.stage!) ? 'pending' : 'in_transit';
  return { status, current_stage: current.stage, current_stage_source: current.stage_source,
    last_status_text: current.description, last_update: current.time ?? null, events,
    ...(typeof shipment.consigneeCountryCode === 'string' && /^[A-Z]{2}$/.test(shipment.consigneeCountryCode)
      ? { destination_country: shipment.consigneeCountryCode } : {}) };
}

export class DhlExpressTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async direct(number: string, context?: TrackingContext): Promise<CarrierResult> {
    const budget = lookupBudget(context, 10_000, PROVIDER);
    const { bytes } = await fetchBounded(apiUrl(normalizeNumber(number)), {
      headers: { accept: 'application/json', 'user-agent': this.environment.userAgent ?? 'Mozilla/5.0' }, signal: budget.signal,
    }, { provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: MAX_BYTES, fetcher: this.environment.fetcher });
    if (/^\s*</.test(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'DHL Express rejected the tracking request');
    return this.decode(bytes, number);
  }

  async browser(number: string, context?: TrackingContext): Promise<CarrierResult> {
    const budget = lookupBudget(context, 45_000, PROVIDER);
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'DHL Express requires the browser tracking service');
    const timeoutMs = budget.remainingMs() - TRAWL_TRANSPORT_ALLOWANCE_MS;
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, budget.budgetMs);
    const page = await this.environment.trawl.scrape({ url: trackingUrl(number), skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: Math.min(timeoutMs, 10_000),
    }, { provider: PROVIDER, timeoutMs, signal: budget.signal, maxBytes: 6_000_000, requireSolved: false });
    budget.signal.throwIfAborted();
    const captures = page.capturedResponses.filter((r) => {
      try { const url = new URL(r.url); return url.origin + url.pathname === API && !url.username && !url.password
        && url.searchParams.getAll('AWB').length === 1 && url.searchParams.get('AWB') === number && r.status !== 204; }
      catch { return false; }
    });
    const response = captures.at(-1);
    if (!response || captures.length > 10 || response.error || response.truncated || response.base64Encoded || response.body === null) {
      throw new TransportError(PROVIDER, 'DHL Express returned no complete matching browser response');
    }
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403].includes(response.status) || /^\s*</.test(response.body)) throw new ChallengeError(PROVIDER);
    if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.status !== 200 || Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'DHL Express returned invalid browser data');
    return this.decode(new TextEncoder().encode(response.body), number);
  }

  private decode(bytes: Uint8Array, number: string): CarrierResult {
    let payload: unknown;
    try { payload = parseJsonBytes(bytes, PROVIDER); }
    catch (error) { throw new SchemaError(PROVIDER, 'DHL Express returned invalid tracking JSON', { cause: error }); }
    return parse(payload, number);
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
      try {
        const result = await tracker.browser(normalizeNumber(number), context);
        // Local facility clocks establish dated activity, but never an instant for ranking reuse.
        return result.events?.some((event) => event.time) ? { known: true, lastActivityAt: null, result } : { known: false };
      } catch (error) { if (error instanceof NotFoundError) return { known: false }; throw error; }
    } };
};
