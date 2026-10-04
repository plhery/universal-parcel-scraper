
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyInpostStatus } from './status.js';

// Protocol provenance:
// - Prior art (structure + vocabulary, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-inpost (const.py,
//   parcels.py normalize_tracking_parcel/TRACKING_STATUS_MAP, tests).
//   Two public surfaces exist: the ShipX tracking endpoint
//   (api-shipx-pl.easypack24.net, keyless, but its success shape is
//   unconfirmed) and the inposteasy.com per-country hubs below. Only the
//   inposteasy hub is implemented here; ShipX remains a future lead.
// - Unknown or expired numbers return an identity-bound NOT_FOUND problem,
//   optionally JSON-encoded inside the tracking-error wrapper's detail field.
// - The public cross-border status vocabulary lives in status.ts.
const TRACKING_ENDPOINT = 'https://inposteasy.com/api/tracking';
const DEFAULT_TIMEOUT_MS = 15_000;
/** The pause `fetchBounded` takes before its one retry of a failed request. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;

function statusCode(value: unknown): string {
  return clean(value, 32).toLocaleUpperCase('en-US');
}

export function normalizeInpostTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^(?:\d{24}|JJD\d{16}|JD\d{16}|8YDR\d{9})$/.test(value)) {
    throw new InvalidInputError('InPost', 'InPost tracking requires a 24-digit, JJD/JD legacy or 8YDR identifier');
  }
  return value;
}

function isNotFoundProblem(payload: unknown, trackingNumber: string): boolean {
  if (!isRecord(payload) || payload.status !== 404
    || payload.instance !== `/api/tracking/${trackingNumber}`) return false;
  if (payload.type === '/errors/external/not-found' && payload.title === 'NOT_FOUND') return true;
  if (payload.type !== '/errors/external/tracking-error' || typeof payload.detail !== 'string') return false;
  try {
    const nested: unknown = JSON.parse(payload.detail.replace(/^Tracking client failed\. /, ''));
    return isRecord(nested) && nested.type === '/errors/external/not-found'
      && nested.title === 'NOT_FOUND' && nested.status === 404 && nested.instance === payload.instance;
  } catch {
    return false;
  }
}

export function parseInpostTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizeInpostTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('InPost', 'InPost returned an invalid tracking response');
  const returned = clean(payload.trackingNumber, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!returned) throw new SchemaError('InPost', 'InPost did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('InPost', 'InPost returned a different shipment');
  const code = statusCode(payload.status);
  const classified = classifyInpostStatus(code);
  const rawDetails = payload.trackingDetails;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new SchemaError('InPost', 'InPost returned invalid tracking history');
  }
  const parsed: Array<{ event: CarrierEvent; timestamp: number; index: number }> = [];
  const seen = new Set<string>();
  (Array.isArray(rawDetails) ? rawDetails : []).filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const eventCode = statusCode(rawEvent.status);
    const eventClassified = classifyInpostStatus(eventCode);
    // Observed event datetimes carry explicit offsets; require them rather than
    // assigning a zone to a multi-country lane (PL/IT/PT/GB hubs share this API).
    const time = explicitOffsetTime(rawEvent.datetime);
    // statusTitle is the backend's fixed English wording for the requested hub.
    // Origin/destination country codes travel alongside the parcel but feed no
    // retained field: only normalized status and timeline fields are projected.
    const description = clean(rawEvent.statusTitle, 500) || eventCode;
    if (!time || !description) return;
    const identity = `${time.iso}\u0000${description}\u0000${eventCode}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    parsed.push({
      // An unmapped code keeps no stage: the sync classifies the wording and
      // records where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: '',
        description,
        ...(eventClassified ? { stage: eventClassified.stage } : {}),
      },
      timestamp: time.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  if (!classified) {
    return {
      status: 'unknown',
      last_status_text: clean(payload.statusTitle, 500) || clean(payload.statusDescription, 500) || code || 'Tracking information received',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      events,
    };
  }
  return {
    status: classified.status,
    current_stage: classified.stage,
    last_status_text: clean(payload.statusTitle, 500) || clean(payload.statusDescription, 500) || code,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    events,
  };
}

export class InpostTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    this.userAgent = userAgentOf(options.userAgent);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('InPost timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeInpostTrackingNumber(rawTrackingNumber);
    // The default budget covers the request, the pause and the one transient retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    const url = `${TRACKING_ENDPOINT}/${encodeURIComponent(trackingNumber)}`;
    const { response, bytes } = await fetchBounded(url, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': this.userAgent,
      },
    }, {
      provider: 'InPost tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      allowHttpStatuses: [404],
      fetcher: this.fetcher,
    });
    if (response.status === 404) {
      let problem: unknown;
      try { problem = parseJsonBytes(bytes, 'InPost tracking'); } catch { /* An HTML error page proves no shipment outcome. */ }
      if (isNotFoundProblem(problem, trackingNumber)) throw new NotFoundError('InPost');
      throw new IndeterminateError('InPost', 'InPost returned an unrecognized not-found response');
    }
    return parseInpostTrackingResponse(parseJsonBytes(bytes, 'InPost tracking'), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new InpostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'inpost',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeInpostTrackingNumber(number))),
  };
};
