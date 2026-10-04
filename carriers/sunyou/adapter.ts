
/**
 * SunYou tracking.
 *
 * `sypost.net/queryTrack` is the keyless endpoint the public search page uses.
 * It answers with JSONP (`callbackName({...})`) rather than JSON and expects a
 * cache-busting `queryTime`, so the body is unwrapped before it is parsed.
 *
 * A shipment is returned in two legs — `result.origin` and
 * `result.destination` — each stamping its own timezone. Events are merged and
 * ordered by absolute instant, never by comparing wall-clock strings across
 * legs.
 */
import { randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { sunYouStatus } from './status.js';

const PROVIDER = 'SunYou';
const UPSTREAM = 'SunYou tracking';
const QUERY_URL = 'https://sypost.net/queryTrack';
const JSONP_ENVELOPE = /^\s*\w+\(([\s\S]*)\)\s*;?\s*$/;
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;
const LEG_OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS_TO_RETURN = 20;
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

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
  return text(value).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

/**
 * The event's timestamp, with the leg's offset applied when the provider gives
 * one. This is not `core/time`'s `explicitOffsetTime`: that policy rejects a
 * value it cannot resolve, while SunYou's provider text must pass through
 * unchanged instead of disappearing — a naive string is still the only thing
 * the carrier said about that scan, and inventing a zone would be worse.
 */
function sunYouEventTime(event: JsonObject): string {
  const raw = text(event.createTime);
  if (!raw || EXPLICIT_OFFSET.test(raw)) return raw;
  // Origin/destination legs stamp their own zone (observed "+08:00" on origin
  // scans of a captured SYAE shipment). Honor an explicit offset instead of
  // comparing wall-clock strings across legs; without a usable offset the
  // provider text passes through unchanged — never invented.
  const zone = LEG_OFFSET.exec(text(event.timeZone));
  if (!zone) return raw;
  const parsed = DateTime.fromISO(
    `${raw.replace(' ', 'T')}${zone[1]}${zone[2]}:${zone[3]}`,
    { setZone: true },
  );
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) ?? raw : raw;
}

function sunYouEventInstant(event: JsonObject): number {
  // fromISO needs the T separator; provider wall-clock strings use a space.
  const parsed = DateTime.fromISO(sunYouEventTime(event).replace(' ', 'T'), { setZone: true });
  return parsed.isValid ? parsed.toMillis() : Number.NEGATIVE_INFINITY;
}

/** Unwraps the JSONP envelope the search page receives. */
export function parseSunYouEnvelope(body: string): unknown {
  const match = JSONP_ENVELOPE.exec(body);
  if (!match) {
    throw new SchemaError(PROVIDER, 'SunYou returned an invalid tracking response');
  }
  try {
    return JSON.parse(match[1]!);
  } catch (error) {
    throw new SchemaError(PROVIDER, 'SunYou returned an invalid tracking response', { cause: error });
  }
}

/** Projects one unwrapped payload. Pure: the offline tests target this. */
export function parseSunYouTrackingResponse(value: unknown, trackingNumber: string): CarrierResult {
  const payload = record(value);
  if (!Array.isArray(payload.data)) {
    throw new SchemaError(PROVIDER, 'SunYou returned an invalid tracking response');
  }
  const items = recordArray(payload.data);
  if (items.length !== payload.data.length) {
    throw new SchemaError(PROVIDER, 'SunYou returned an invalid shipment entry');
  }
  if (items.length === 0) throw new SchemaError(PROVIDER, 'SunYou did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = items.filter((candidate) => comparableIdentifier(candidate.orderNo));
  if (identified.length === 0) throw new SchemaError(PROVIDER, 'SunYou did not return a shipment identifier');
  const item = identified.find((candidate) => comparableIdentifier(candidate.orderNo) === requested);
  if (!item) throw new SchemaError(PROVIDER, 'SunYou returned a different shipment');
  const displayStatus = cleanScalar(item.displayStatus, 16);
  if (displayStatus === '0') throw new NotFoundError(PROVIDER);
  if (item.has !== true) throw new NotFoundError(PROVIDER);
  const result = record(item.result);
  const allEvents = [
    ...recordArray(record(result.origin).items),
    ...recordArray(record(result.destination).items),
  ].sort((left, right) => sunYouEventInstant(right) - sunYouEventInstant(left));
  const classified = sunYouStatus(displayStatus);
  const events = allEvents.slice(0, MAX_EVENTS_TO_RETURN).map((event, index): CarrierEvent => ({
    time: sunYouEventTime(event),
    location: '',
    description: text(event.content),
    ...(index === 0 && classified ? { stage: classified.stage } : {}),
  }));
  return {
    status: classified?.status ?? 'in_transit',
    ...(classified ? { current_stage: classified.stage } : {}),
    last_status_text: text(item.lastContent) || events[0]?.description || '',
    last_update: text(item.lastUpdate) || events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

export class SunYouTracker {
  private readonly fetcher: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const budget = lookupBudget(context, this.timeoutMs);
    const queryTime = `${Date.now()}-${randomInt(10_000, 100_000)}`;
    const { bytes } = await fetchBounded(
      `${QUERY_URL}?${new URLSearchParams({
        queryTime,
        toLanguage: 'en_US',
        trackNumber: trackingNumber,
      })}`,
      {
        signal: budget.signal,
        headers: { ...BASE_HEADERS, 'User-Agent': this.userAgent, Referer: 'https://sypost.net/search' },
      },
      { provider: UPSTREAM, timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()), fetcher: this.fetcher },
    );
    return parseSunYouTrackingResponse(parseSunYouEnvelope(decodeText(bytes)), trackingNumber);
  }
}

/** Kept for the host's legacy dispatch chain until it is deleted. */
export async function fetchSunYou(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
  return new SunYouTracker().fetch(trackingNumber, context);
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SunYouTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'sunyou',
    // One keyless GET; there is no second tier to fall back to.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
