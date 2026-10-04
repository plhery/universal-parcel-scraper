
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyPacketaStatus, packetaEventStage } from './status.js';

// Protocol provenance:
// - Prior art (structure + contract, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-packeta (api.py, parcels.py,
//   tests/payloads.py — keyless consumer POST, 200 {item} / 404 notFound).
// - Live verification 2026-09-10: POST
//   https://tracking.packeta.com/api/getPacketById/Z0000000000/en returns
//   HTTP 404 {"error":"notFound"} in ~0.2s with no cookies, headers or account.
//   Expired 2023-era reported Z codes return the same 404 (unknown and expired
//   are intentionally indistinguishable to anonymous callers).
// - Shape reference: the prior-art payload samples (confirmed live 2026-08-19
//   against real delivered parcels; values fictionalized there). Only
//   packetStatusId "3" (delivered) is live-confirmed; the other codes are
//   reconstructed — an unmapped code is schema drift, never a guess. The maps
//   live in status.ts.
const TRACKING_ENDPOINT = 'https://tracking.packeta.com/api/getPacketById';
const TRACKING_LOCALE = 'en';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `fetchBounded` repeats a request that failed in transit once, after this pause. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;

function parsedTime(value: unknown): { iso: string; timestamp: number } | null {
  const raw = clean(value, 32);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  // Packeta emits naive wall-clock times with no offset. The backend stamps
  // Europe/Prague time (verified against real parcels by the prior-art client);
  // Romania (EET) depot scans can therefore be off by one hour. There is no
  // per-event locality to do better, so ordering within a parcel is preserved
  // while the zone caveat stays documented here instead of inventing UTC.
  return zonedTime(raw, 'yyyy-MM-dd HH:mm:ss', 'Europe/Prague');
}

export function normalizePacketaTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^Z\d{10}$/.test(value)) {
    throw new InvalidInputError('Packeta', 'Packeta tracking requires a Z-prefixed barcode with ten digits');
  }
  return value;
}

export function packetaTrackingUrl(rawTrackingNumber: string): string {
  // Canonical path form: the legacy ?id= form 301-redirects here (verified live).
  return `https://tracking.packeta.com/en/${encodeURIComponent(normalizePacketaTrackingNumber(rawTrackingNumber))}`;
}

export function parsePacketaTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizePacketaTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Packeta', 'Packeta returned an invalid tracking response');
  const item = payload.item;
  // Only the named notFound error establishes absence; other API errors say
  // nothing about the requested parcel.
  if (!isRecord(item)) {
    if (payload.error === 'notFound') throw new NotFoundError('Packeta');
    if (typeof payload.error === 'string') throw new IndeterminateError('Packeta', 'Packeta returned a tracking error');
    throw new SchemaError('Packeta', 'Packeta returned an invalid tracking response');
  }
  const returned = typeof item.barcode === 'string'
    ? item.barcode.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '') : '';
  if (!returned) throw new SchemaError('Packeta', 'Packeta did not return a shipment identifier');
  if (returned !== requested && returned !== requested.slice(1)) {
    throw new SchemaError('Packeta', 'Packeta returned a different shipment');
  }
  const code = clean(item.packetStatusId, 16);
  const classified = classifyPacketaStatus(code);
  const rawDetails = item.trackingDetails;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new SchemaError('Packeta', 'Packeta returned invalid tracking history');
  }
  const parsed: Array<{ event: CarrierEvent; timestamp: number; index: number }> = [];
  const seen = new Set<string>();
  (Array.isArray(rawDetails) ? rawDetails : []).filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const time = parsedTime(rawEvent.time);
    const description = clean(rawEvent.text, 500);
    if (!time || !description) return;
    const identity = `${time.iso}\u0000${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = packetaEventStage(description);
    parsed.push({
      // Unrecognized sentences keep no stage so schema drift surfaces as a
      // data outcome instead of a wrong movement claim.
      event: { time: time.iso, location: '', description, ...(stage ? { stage } : {}) },
      timestamp: time.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  // Sender (merchant) and branchAddress (Z-BOX/partner shop) carry no
  // recipient PII and are the only pickup signal — Packeta exposes no ETA.
  const sender = clean(item.sender, 200) || null;
  const pickupPoint = clean(item.branchAddress, 300) || null;
  const deliveredAt = classified?.status === 'delivered' ? events[0]?.time ?? null : null;
  if (!classified) {
    return {
      status: 'unknown',
      last_status_text: clean(item.packetStatus, 500) || events[0]?.description || 'Tracking information received',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      timezone: 'Europe/Prague',
      ...(sender ? { sender_name: sender } : {}),
      ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
      events,
    };
  }
  return {
    status: classified.status,
    current_stage: classified.stage,
    // packetStatus is the backend's fixed English wording for the requested
    // locale.
    last_status_text: clean(item.packetStatus, 500) || events[0]?.description || 'Tracking information received',
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    timezone: 'Europe/Prague',
    ...(sender ? { sender_name: sender } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events,
  };
}

export class PacketaTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    this.userAgent = userAgentOf(options.userAgent);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Packeta timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizePacketaTrackingNumber(rawTrackingNumber);
    // The default budget covers the request, the pause and the one transient retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    const url = `${TRACKING_ENDPOINT}/${encodeURIComponent(trackingNumber)}/${TRACKING_LOCALE}`;
    const { response, bytes } = await fetchBounded(url, {
      method: 'POST',
      signal: budget.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': this.userAgent,
      },
    }, {
      provider: 'Packeta tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    if (response.status === 404) {
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'Packeta tracking'); }
      catch { throw new UpstreamHttpError('Packeta tracking', response.status); }
      if (isRecord(payload) && payload.error === 'notFound') throw new NotFoundError('Packeta');
      throw new UpstreamHttpError('Packeta tracking', response.status);
    }
    if (!response.ok) throw new UpstreamHttpError('Packeta tracking', response.status);
    return parsePacketaTrackingResponse(parseJsonBytes(bytes, 'Packeta tracking'), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PacketaTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'packeta',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
