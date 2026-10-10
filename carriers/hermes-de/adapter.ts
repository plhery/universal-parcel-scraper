
import { DateTime } from 'luxon';
import { lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { COLLECTED_AT_PARCELSHOP, hermesGermanyMilestone, IGNORED_BOOKING_STATUS, type Milestone } from './status.js';

// Public recipient protocol inspected 2026-09-08:
// https://gcp-prd.my-deliveries.de/tnt/bundle/tnt-bundle-v2.js
// Separate from Hermes Einrichtungs-Service (myhes.de). The postcode-protected
// address endpoint is deliberately not called.
const API = 'https://api.my-deliveries.de/tnt/v2/shipments/search/';
const PROVIDER = 'Hermes Germany tracking';
const CARRIER = 'Hermes Germany';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HermesGermanyOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export { STATUSES } from './status.js';

function etaDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const raw = clean(value, 64);
  if (!raw) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (parsed.isValid) return parsed.toISODate();
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : null;
}

/** Kept as a named class: the grouped live suite asserts this error's name. */
export class HermesGermanyTrackingError extends NotFoundError {
  constructor() {
    super(CARRIER);
    this.name = 'HermesGermanyTrackingError';
  }
}

export function normalizeHermesGermanyNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{8,20}$/.test(value)) {
    throw new InvalidInputError(CARRIER, 'Hermes Germany requires an 8-to-20-character tracking number');
  }
  return value;
}

/**
 * The ParcelShop holding the parcel, or the one it was collected from: its
 * name, street and town. Only a ParcelShop address is read; any other address
 * type is the recipient's or a neighbour's and is never touched.
 */
function parcelShop(parcel: Record<string, unknown>, latest: { metadata?: Milestone; event: CarrierEvent }): string | null {
  const address = isRecord(parcel.address) ? parcel.address : {};
  if (address.addressType !== 'PARCELSHOP') return null;
  const atShop = latest.metadata?.stage === 'ready_for_pickup'
    || COLLECTED_AT_PARCELSHOP.has(String(latest.event.provider_code));
  if (!atShop) return null;
  const name = clean(address.lastName, 120);
  if (!name) return null;
  const town = [clean(address.zipCode, 16), clean(address.city, 80)].filter(Boolean).join(' ');
  return [name, clean(address.street, 120), town].filter(Boolean).join('\n');
}

export function parseHermesGermanyResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizeHermesGermanyNumber(trackingNumber);
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking response');
  }
  if (!payload.length) throw new HermesGermanyTrackingError();
  const parcels = payload.filter((entry) => entry.barcode === requested);
  if (parcels.length !== 1) throw new SchemaError(CARRIER, 'Hermes Germany returned a different or ambiguous shipment');
  const progress = parcels[0]!.parcelProgress;
  if (!Array.isArray(progress) || !progress.length || progress.length > 500) {
    throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking history');
  }
  const seen = new Set<string>();
  const events: Array<{ event: CarrierEvent; timestamp: number; metadata?: Milestone }> = [];
  for (const entry of progress) {
    if (!isRecord(entry) || typeof entry.timestamp !== 'string'
      || typeof entry.parcelStatus !== 'string' || !/^[A-Z_]{1,64}$/.test(entry.parcelStatus)) {
      throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid tracking event');
    }
    const date = DateTime.fromISO(entry.timestamp, { zone: 'Europe/Berlin', setZone: true });
    if (!date.isValid) throw new SchemaError(CARRIER, 'Hermes Germany returned an invalid event date');
    const time = date.toUTC().toISO();
    const identity = `${time}|${entry.parcelStatus}`;
    if (seen.has(identity) || IGNORED_BOOKING_STATUS.has(entry.parcelStatus)) continue;
    seen.add(identity);
    const metadata = hermesGermanyMilestone(entry.parcelStatus);
    // historyText is the carrier's display wording; the `status` field only
    // carries generic HAPPY/FINISHED buckets and is never display text.
    const rawText = clean(entry.historyText);
    events.push({
      timestamp: date.toMillis(),
      metadata,
      event: {
        time,
        description: rawText || metadata?.description || 'Hermes tracking update',
        // An unmapped code is left to the shared wording classifier.
        ...(metadata ? { stage: metadata.stage } : {}),
        provider_code: entry.parcelStatus,
      },
    });
  }
  events.sort((a, b) => b.timestamp - a.timestamp);
  const latest = events[0];
  if (!latest) throw new HermesGermanyTrackingError();
  const parcel = parcels[0] as Record<string, unknown>;
  const attributes = isRecord(parcel.parcelAttributes) ? parcel.parcelAttributes : {};
  const atg = isRecord(parcel.atg) ? parcel.atg : {};
  const sender = clean(atg.companyName) || null;
  const eta = etaDate(parcel.eta ?? parcel.deliveryForecast ?? attributes.deliveredTimestamp);
  const deliveredByCode = latest.metadata?.status === 'delivered';
  const deliveredByFlag = attributes.delivered === true;
  const delivered = deliveredByCode || deliveredByFlag;
  if (!latest.metadata && !delivered) {
    return {
      status: 'unknown',
      last_status_text: latest.event.description,
      last_update: latest.event.time,
      expected_delivery: null,
      timezone: 'Europe/Berlin',
      ...(sender ? { sender_name: sender } : {}),
      events: events.slice(0, 100).map(({ event }) => event),
    };
  }
  const status = delivered ? 'delivered' as const : latest.metadata!.status;
  const stage = latest.metadata?.stage ?? (delivered ? 'delivered' : 'in_transit');
  const deliveredAt = delivered ? latest.event.time : null;
  const pickupPoint = parcelShop(parcel, latest);
  return {
    status,
    current_stage: stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time,
    expected_delivery: delivered ? null : eta,
    timezone: 'Europe/Berlin',
    ...(sender ? { sender_name: sender } : {}),
    ...(deliveredAt && status === 'delivered' ? { delivered_at: deliveredAt } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    events: events.slice(0, 100).map(({ event }) => event),
  };
}

export class HermesGermanyTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | HermesGermanyOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, fetcher: undefined, userAgent: undefined }
      : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Hermes Germany timeout must be positive');
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHermesGermanyNumber(trackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { response, bytes } = await fetchBounded(`${API}${encodeURIComponent(number)}`, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'X-Language': 'de',
        Referer: 'https://www.myhermes.de/',
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: PROVIDER,
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: 750_000,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    if (response.status === 404) throw new HermesGermanyTrackingError();
    if (!response.ok) throw new UpstreamHttpError(PROVIDER, response.status);
    return parseHermesGermanyResponse(parseJsonBytes(bytes, PROVIDER), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HermesGermanyTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'hermes-de',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context)),
  };
};
