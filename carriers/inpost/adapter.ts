
import { accepted, lookupBudget, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { runSteps } from '../../core/runner/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyInpostStatus, keepsInpostStage } from './status.js';
import { needsInpostPickup, parseInpostPickup } from './pickup.js';
import { inpostClock } from './clock.js';
import { INPOST_UK_NUMBER } from './number.js';
import { parseInpostShipxSummary } from './shipx.js';
import { fetchInpostUk, INPOST_UK_BROWSER_MS, type InpostUkParcel } from './uk.js';

// Protocol provenance:
// - Prior art (structure + vocabulary, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-inpost (const.py,
//   parcels.py normalize_tracking_parcel/TRACKING_STATUS_MAP, tests).
//   Two public surfaces exist: the ShipX tracking endpoint
//   (api-shipx-pl.easypack24.net, keyless) and the inposteasy.com
//   per-country hubs below. ShipX can enrich a hub-confirmed collection
//   with its pickup point or confirm current state after a parcel-specific
//   hub failure; its smaller coverage never replaces hub history.
// - Unknown or expired numbers return an identity-bound NOT_FOUND problem,
//   optionally JSON-encoded inside the tracking-error wrapper's detail field.
// - The public cross-border status vocabulary lives in status.ts.
const TRACKING_ENDPOINT = 'https://inposteasy.com/api/tracking';
const PICKUP_ENDPOINT = 'https://api-shipx-pl.easypack24.net/v1/tracking';
const DEFAULT_TIMEOUT_MS = 15_000;
/** The pause `fetchBounded` takes before its one retry of a failed request. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;
// Accepted at the Logistics Centre.
const FIRST_RECEIPT = 'MMD.1001';

function statusCode(value: unknown): string {
  return clean(value, 32).toLocaleUpperCase('en-US');
}

export function normalizeInpostTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^\d{24}$/.test(value) && !INPOST_UK_NUMBER.test(value)) {
    throw new InvalidInputError('InPost', 'InPost tracking requires a 24-digit, JJD/JD legacy, 8YDR or Yodel identifier');
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

function isHubTrackingFailure(error: unknown, number: string): boolean {
  if (!(error instanceof UpstreamHttpError) || error.status !== 500
    || error.retryAfterMs || error.diagnostics?.body_read !== 'complete') return false;
  try {
    const problem: unknown = JSON.parse(error.diagnostics.body_excerpt ?? '');
    return isRecord(problem) && problem.type === '/errors/external/tracking-error'
      && problem.status === 500 && problem.instance === `/api/tracking/${number}`;
  } catch { return false; }
}

/** One scan as an InPost tracker words it: its code, its wording, its clock and its place. */
interface InpostScan { code: string; wording: string; time: unknown; place: string }
interface StagedScan { event: CarrierEvent; code: string; classified?: ClassifiedStatus; timestamp: number }

/**
 * Scans newest first, each once and staged by its code, and the parcel's current stage from its status code and
 * wording. The hub and InPost UK's own tracker share the codes.
 */
function stageInpostScans(scans: readonly InpostScan[], code: string, wording: string): { parsed: StagedScan[]; current?: ClassifiedStatus } {
  const parsed: StagedScan[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    const eventClassified = classifyInpostStatus(scan.code, scan.wording);
    // Observed event datetimes carry explicit offsets; require them rather than
    // assigning a zone to a multi-country lane (PL/IT/PT/GB hubs share this API).
    const time = inpostClock(scan.time);
    const description = scan.wording || scan.code;
    if (!time || !description) continue;
    const identity = `${time.iso}\u0000${description}\u0000${scan.code}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    parsed.push({
      // An unmapped code keeps no stage: the sync classifies the wording and
      // records where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: /^null\b/i.test(scan.place) ? '' : scan.place,
        description,
        ...(scan.code ? { provider_code: scan.code } : {}),
        ...(eventClassified ? { stage: eventClassified.stage } : {}),
      },
      code: scan.code,
      ...(eventClassified ? { classified: eventClassified } : {}),
      timestamp: time.timestamp,
    });
  }
  if (listsNewestFirst(parsed.map(({ event }) => event)) === false) parsed.reverse();
  parsed.sort((left, right) => right.timestamp - left.timestamp);
  // A redirect or a delay notice keeps the stage the parcel had before it.
  let before: ClassifiedStatus | undefined;
  for (const entry of [...parsed].reverse()) {
    if (!entry.classified && keepsInpostStage(entry.code) && before) {
      entry.classified = before;
      entry.event.stage = before.stage;
    }
    before = entry.classified ?? before;
  }
  // The logistics centre's receipt is the acceptance when only the parcel's creation comes before it: a sender
  // delivering to the centre itself has no posting or collection scan.
  const oldestFirst = [...parsed].reverse();
  const moved = oldestFirst.findIndex((entry) => entry.classified && entry.classified.stage !== 'registered');
  const firstMove = moved > 0 && oldestFirst.slice(0, moved).some((entry) => entry.classified?.stage === 'registered') ? oldestFirst[moved] : undefined;
  if (firstMove?.code === FIRST_RECEIPT) {
    firstMove.classified = { status: 'in_transit', stage: 'accepted' };
    firstMove.event.stage = 'accepted';
  }
  const current = (code === FIRST_RECEIPT && firstMove && parsed[0] === firstMove ? firstMove.classified : classifyInpostStatus(code, wording))
    ?? (keepsInpostStage(code) ? parsed.find((entry) => entry.classified)?.classified : undefined);
  return { parsed, ...(current ? { current } : {}) };
}

export function parseInpostTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizeInpostTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('InPost', 'InPost returned an invalid tracking response');
  const returned = clean(payload.trackingNumber, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!returned) throw new SchemaError('InPost', 'InPost did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('InPost', 'InPost returned a different shipment');
  const code = statusCode(payload.status);
  const rawDetails = payload.trackingDetails;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new SchemaError('InPost', 'InPost returned invalid tracking history');
  }
  const { parsed, current } = stageInpostScans((Array.isArray(rawDetails) ? rawDetails : []).filter(isRecord).slice(0, 500)
    .map((rawEvent) => ({
      code: statusCode(rawEvent.status),
      // statusTitle is the backend's fixed wording for the requested hub.
      wording: clean(rawEvent.statusTitle, 500),
      time: rawEvent.datetime,
      // A place is a town or hub with its country, such as "Exampletown (PL)";
      // one with no town comes as "null (PL)".
      place: clean(rawEvent.place, 200),
    })), code, clean(payload.statusTitle, 500));
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  // Of the destination only the country code is sent; the origin country feeds no field.
  const country = isRecord(payload.destination) ? payload.destination.countryCode : undefined;
  const destination = typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { destination_country: country } : {};
  // The recipient as the hub names them. The phone is not kept.
  const receiverName = clean(payload.receiverName, 160);
  const receiverAddress = clean(payload.receiverAddress, 300);
  const recipient = {
    ...(receiverName ? { receiver_name: receiverName } : {}),
    ...(receiverAddress ? { receiver_address: receiverAddress } : {}),
  };
  if (!current) {
    return {
      status: 'unknown',
      last_status_text: clean(payload.statusTitle, 500) || clean(payload.statusDescription, 500) || code || 'Tracking information received',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      ...destination,
      ...recipient,
      events,
    };
  }
  // A parcel in one of InPost UK's layouts that the hub knows only by its creation: InPost UK's own tracker, which the
  // providers relay, has the parcel on its way and received ("We have your parcel") days before the hub's first warehouse
  // scan, so the answer is partial and a fuller provider history may replace it.
  const ukCreationOnly = INPOST_UK_NUMBER.test(requested) && current.stage === 'registered'
    && parsed.every((entry) => entry.classified?.stage === 'registered');
  const delivery = current.status === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  // The name the hub gives for a delivery's signature; an image or a link is not one.
  const signature = clean(payload.signature, 121);
  const signedBy = current.status === 'delivered' && signature.length <= 120 && /\p{L}/u.test(signature)
    && !/^(?:data:|https?:)/i.test(signature) ? signature : '';
  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: clean(payload.statusTitle, 500) || clean(payload.statusDescription, 500) || code,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time } : {}),
    ...destination,
    ...recipient,
    ...(signedBy ? { signed_by: signedBy } : {}),
    ...(ukCreationOnly ? { history_truncated: true } : {}),
    events,
  };
}

/**
 * A parcel as InPost UK's own tracker shows it: its scans staged by their codes, the newest giving the current stage.
 * Its summary status is the page's badge and stages nothing.
 */
export function inpostUkResult(parcel: InpostUkParcel): CarrierResult {
  const { parsed } = stageInpostScans(parcel.scans, '', '');
  const current = parsed[0]?.classified;
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const text = parcel.statusTitle || parcel.statusDescription || events[0]?.description || 'Tracking information received';
  const destination = parcel.destinationCountry ? { destination_country: parcel.destinationCountry } : {};
  if (!current) return { status: 'unknown', last_status_text: text, last_update: events[0]?.time ?? null, expected_delivery: null, ...destination, events };
  const delivery = current.status === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: current.status,
    current_stage: current.stage,
    last_status_text: text,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time } : {}),
    ...destination,
    events,
  };
}

/** The hub knows a UK parcel by its creation alone: InPost UK's own tracker may hold the rest. */
class InpostUkCreationOnlyError extends IndeterminateError {
  constructor(readonly result: CarrierResult) {
    super('InPost', 'InPost\'s hub knows the UK parcel by its creation alone');
    this.name = 'InpostUkCreationOnlyError';
  }
}

/** The languages the hub words its scans in for a reader. */
type InpostLanguage = 'pl' | 'en';

export class InpostTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;
  private readonly recorder: StepRecorder | undefined;
  private readonly trawl: TrawlClient | null;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder; trawl?: TrawlClient | null } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    this.userAgent = userAgentOf(options.userAgent);
    this.recorder = options.recorder;
    this.trawl = options.trawl ?? null;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('InPost timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}, enrich = true, language: InpostLanguage = 'en'): Promise<CarrierResult> {
    const trackingNumber = normalizeInpostTrackingNumber(rawTrackingNumber);
    // The default budget covers the request, the pause and the one transient retry.
    // A UK parcel the hub knows by its creation alone, or not at all, is asked of InPost UK's own tracker through the
    // browser service; recognition stays on the hub.
    const uk = enrich && INPOST_UK_NUMBER.test(trackingNumber) && this.trawl !== null;
    // The default budget covers the request, the pause and the one transient retry, and InPost UK's page when it may be asked.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS
      + (uk ? INPOST_UK_BROWSER_MS + TRAWL_TRANSPORT_ALLOWANCE_MS : 0));
    return runSteps({ carrier: 'inpost', budgetMs: budget.remainingMs(), signal: budget.signal, recorder: this.recorder }, [{
      id: 'direct',
      run: async ({ signal, remainingMs }) => {
        const result = await this.fetchHub(trackingNumber, { signal, budgetMs: remainingMs }, enrich, language);
        if (uk && result.history_truncated) throw new InpostUkCreationOnlyError(result);
        return result;
      },
    }, {
      id: 'shipx',
      // Recognition and UK layouts keep the hub's broader scope.
      enabled: enrich && /^\d{24}$/.test(trackingNumber),
      recovers: error => isHubTrackingFailure(error, trackingNumber),
      run: async ({ signal, remainingMs, previousError }) => {
        const { response, bytes } = await fetchBounded(`${PICKUP_ENDPOINT}/${trackingNumber}`, {
          signal, headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        }, { provider: 'InPost ShipX', timeoutMs: Math.min(this.timeoutMs, remainingMs), maxBytes: MAX_RESPONSE_BYTES,
          allowHttpStatuses: [404], fetcher: this.fetcher });
        // ShipX's narrower coverage cannot turn a failed hub into a parcel negative.
        if (response.status === 404) throw previousError;
        const result = parseInpostShipxSummary(parseJsonBytes(bytes, 'InPost ShipX'), trackingNumber);
        if (!result) throw previousError;
        signal.throwIfAborted();
        return result;
      },
    }, {
      id: 'trawl',
      enabled: uk,
      recovers: (error) => error instanceof InpostUkCreationOnlyError || error instanceof NotFoundError,
      run: async ({ signal, remainingMs, previousError }) => {
        const hub = previousError instanceof InpostUkCreationOnlyError ? previousError.result : undefined;
        let parcel: InpostUkParcel | null;
        try {
          parcel = await fetchInpostUk({ trawl: this.trawl, fetcher: this.fetcher }, trackingNumber, signal, remainingMs);
        } catch (error) {
          signal.throwIfAborted();
          // When InPost UK's tracker cannot be read, the hub's answer stands: its creation, partial, or its not-found.
          if (hub) return hub;
          throw previousError ?? error;
        }
        if (parcel === null) {
          if (hub) return hub;
          throw new NotFoundError('InPost UK');
        }
        const result = inpostUkResult(parcel);
        // A tracker that adds nothing to the hub's creation leaves the hub's partial answer, which a provider may fill.
        if (hub && !result.events?.some((event) => event.stage !== 'registered')) return hub;
        return result;
      },
    }]);
  }

  private async fetchHub(trackingNumber: string, context: TrackingContext, enrich: boolean, language: InpostLanguage): Promise<CarrierResult> {
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    // The hub words every parcel in Polish, whatever its country or Accept-Language,
    // unless the query names a language: a Polish reader gets that, anyone else English.
    const url = `${TRACKING_ENDPOINT}/${encodeURIComponent(trackingNumber)}${language === 'pl' ? '' : '?language=en'}`;
    const { response, bytes } = await fetchBounded(url, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': language === 'pl' ? 'pl-PL,pl;q=0.9' : 'en-US,en;q=0.9',
        'User-Agent': this.userAgent,
      },
    }, {
      provider: 'InPost tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      deadline: budget.deadline,
      allowHttpStatuses: [404],
      fetcher: this.fetcher,
    });
    if (response.status === 404) {
      let problem: unknown;
      try { problem = parseJsonBytes(bytes, 'InPost tracking'); } catch { /* An HTML error page proves no shipment outcome. */ }
      if (isNotFoundProblem(problem, trackingNumber)) throw new NotFoundError('InPost');
      throw new IndeterminateError('InPost', 'InPost returned an unrecognized not-found response');
    }
    const result = parseInpostTrackingResponse(parseJsonBytes(bytes, 'InPost tracking'), trackingNumber);
    const allowance = Math.min(2_000, budget.deadline - performance.now() - 100);
    if (enrich && /^\d{24}$/.test(trackingNumber) && needsInpostPickup(result) && allowance >= 500) {
      try {
        const { bytes: pointBytes } = await fetchBounded(`${PICKUP_ENDPOINT}/${trackingNumber}`, {
          signal: budget.signal, headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        }, { provider: 'InPost pickup', timeoutMs: Math.floor(allowance), maxBytes: MAX_RESPONSE_BYTES, fetcher: this.fetcher });
        const point = parseInpostPickup(parseJsonBytes(pointBytes, 'InPost pickup'), trackingNumber, result);
        if (point) result.pickup_point = point;
      } catch { /* ShipX absence or failure leaves the hub's verified history usable. */ }
    }
    context.signal?.throwIfAborted();
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new InpostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder,
    trawl: environment.trawl });
  return {
    id: 'inpost',
    steps: ['direct', 'shipx', 'trawl'],
    recordsSteps: true,
    track: (input, context) => tracker.fetch(input.number, context, true, readerLanguage(input, ['pl']) ?? 'en'),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, false), () => accepted(() => normalizeInpostTrackingNumber(number))),
  };
};
