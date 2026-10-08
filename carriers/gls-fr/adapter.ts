/**
 * GLS France: the public consignee endpoint called by moncolis.gls-france.com.
 *
 * One bounded GET per lookup ('direct' step). The response carries the parcel
 * record, its event list, and blocks describing the people involved; `parse()`
 * builds its result from an explicit allowlist of status, timing, sender and
 * operational-location fields, so recipient names, street addresses, contacts,
 * signatures and delivery instructions never leave this module.
 */

import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { isValidGlsParcelNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { EXPLICIT_OFFSET_PATTERN, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  FAILED_DELAYED_DELIVERY,
  glsFranceStatusCode,
  glsFranceStatusMetadata,
  type GLSFranceStatusMetadata,
} from './status.js';

export { glsFranceStatus } from './status.js';

const PROVIDER = 'GLS France';
const TRACKING_API =
  'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes';
const TRACKING_PAGE = 'https://moncolis.gls-france.com/fr';
const TIMEZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 750_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;

function locationCode(value: unknown): string {
  const code = cleanScalar(value, 16).toLocaleUpperCase('en-US');
  return /^[A-Z]{2}[A-Z0-9]{2,8}$/.test(code) ? code : '';
}

/**
 * GLS France puts three shapes on the same timestamp fields: an ISO value with
 * or without an offset, a SQL-style `YYYY-MM-DD HH:mm:ss.S` wall clock, and a
 * bare calendar day. No single `core/time` policy covers all three, so this
 * helper stays local: an explicit offset is honored, everything else is read in
 * Europe/Paris, which is the zone the French backend stamps.
 */
function parsedTime(value: unknown): ParsedTime | null {
  const raw = cleanScalar(value, 64);
  // Empty timestamps arrive padded with year 1 instead of being omitted.
  if (!raw || raw.startsWith('0001-')) return null;
  let parsed = raw.includes('T')
    ? DateTime.fromISO(raw, { setZone: EXPLICIT_OFFSET_PATTERN.test(raw), zone: TIMEZONE })
    : DateTime.fromSQL(raw, { zone: TIMEZONE });
  if (!parsed.isValid && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsed = DateTime.fromISO(raw, { zone: TIMEZONE });
  }
  if (!parsed.isValid) return null;
  const iso = parsed.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

function expectedDelivery(value: unknown): string | null {
  return parsedTime(value)?.iso.slice(0, 10) ?? null;
}

/**
 * A GLS parcel number is 11 digits; labels print it with its check digit as a
 * 12th. A 12-digit number is accepted only when that digit is valid, and is
 * known by its first 11 digits.
 */
function parcelNumber(value: string): string {
  if (/^(?:[A-Z0-9]{8}|\d{11})$/.test(value)) return value;
  return isValidGlsParcelNumber(value) ? value.slice(0, 11) : '';
}

function normalizedCandidate(value: unknown): string {
  return parcelNumber(cleanScalar(value, 32).toLocaleUpperCase('en-US').replace(/[\s.-]/g, ''));
}

function printedNumber(raw: string): string {
  return raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
}

export function normalizeGLSFranceTrackingNumber(raw: string): string {
  const value = parcelNumber(printedNumber(raw));
  if (!value) {
    throw new InvalidInputError(PROVIDER, 'GLS France tracking numbers must contain 8 letters or digits, or 11 digits (12 with a valid check digit)');
  }
  return value;
}

export function glsFranceTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_PAGE}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

export function glsFranceTrackingApiUrl(trackingNumber: string): string {
  return `${TRACKING_API}/${encodeURIComponent(normalizeGLSFranceTrackingNumber(trackingNumber))}`;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function responseIdentifiers(parcel: JsonObject): string[] {
  return [parcel.trackid, parcel.numeroalphaColis, parcel.numeroGp]
    .map(normalizedCandidate)
    .filter(Boolean);
}

interface ParsedEvent {
  event: CarrierEvent;
  timestamp: number;
  sourceIndex: number;
  typeCode: string;
  metadata: GLSFranceStatusMetadata | null;
}

function parseEvent(raw: JsonObject, sourceIndex: number): ParsedEvent | null {
  const eventStatusCode = glsFranceStatusCode(raw.statutEvenement);
  const typeCode = glsFranceStatusCode(raw.typeEvenement);
  const code = eventStatusCode || typeCode;
  const metadata = eventStatusCode === 'DEL' && typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : glsFranceStatusMetadata(code);
  const time = parsedTime(raw.datereference) ?? parsedTime(raw.datecreation);
  if (!code && !time) return null;
  const location = locationCode(raw.codelieuEvenement);
  return {
    timestamp: time?.timestamp ?? Number.NEGATIVE_INFINITY,
    sourceIndex,
    typeCode,
    metadata,
    event: {
      ...(time ? { time: time.iso } : {}),
      ...(location ? { location } : {}),
      description: metadata?.description ?? 'GLS France tracking update',
      // An unmapped code carries no stage: the sync classifies and records it.
      ...(metadata ? { stage: metadata.stage } : {}),
      ...(code ? { provider_code: code } : {}),
    },
  };
}

export function parseGLSFranceTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  const requested = normalizeGLSFranceTrackingNumber(trackingNumber);
  if (!isRecord(payload) || !isRecord(payload.colis)) {
    throw new SchemaError(PROVIDER, 'GLS France returned an invalid tracking response');
  }

  const parcel = payload.colis;
  const identifiers = responseIdentifiers(parcel);
  if (identifiers.length === 0) {
    throw new SchemaError(PROVIDER, 'GLS France did not return a shipment identifier');
  }
  if (!identifiers.includes(requested)) {
    throw new SchemaError(PROVIDER, 'GLS France returned a different shipment');
  }

  const seen = new Set<string>();
  const parsedEvents: ParsedEvent[] = [];
  records(payload.evenements).slice(0, MAX_EVENTS_TO_INSPECT).forEach((raw, index) => {
    const parsed = parseEvent(raw, index);
    if (!parsed) return;
    const identity = JSON.stringify([
      parsed.event.time ?? '',
      parsed.event.location ?? '',
      parsed.event.provider_code ?? '',
    ]);
    if (seen.has(identity)) return;
    seen.add(identity);
    parsedEvents.push(parsed);
  });
  parsedEvents.sort((left, right) => (
    right.timestamp - left.timestamp || left.sourceIndex - right.sourceIndex
  ));
  const latestParsedEvent = parsedEvents[0];
  const events = parsedEvents
    .slice(0, MAX_EVENTS_TO_RETURN)
    .map(({ event }) => event);

  const currentCode = glsFranceStatusCode(parcel.statutColis);
  const current = currentCode === 'DEL' && latestParsedEvent?.typeCode === 'LIV'
    ? FAILED_DELAYED_DELIVERY
    : glsFranceStatusMetadata(currentCode);
  const latestEvent = events[0];
  const latestEventStatus = latestParsedEvent?.metadata ?? glsFranceStatusMetadata(latestEvent?.provider_code);
  const fallbackUpdate = parsedTime(parcel.dateActionColis);
  const status = current?.status ?? latestEventStatus?.status ?? 'unknown';
  const stage = current?.stage ?? latestEventStatus?.stage;
  // Delivered, waiting at a shop or in trouble, the portal shows the scan's
  // own day instead of the theoretical one, which is then stale.
  const settled = status === 'delivered' || status === 'exception' || stage === 'ready_for_pickup';
  // The portal shows this label as the sender.
  const sender = clean(parcel.libelleExpediteur, 200);
  return {
    status,
    last_status_text: current?.description
      ?? latestEvent?.description
      ?? 'Tracking information received',
    last_update: latestEvent?.time ?? fallbackUpdate?.iso ?? null,
    expected_delivery: settled ? null : expectedDelivery(parcel.dateTheoriqueLivraison),
    ...(sender ? { sender_name: sender } : {}),
    timezone: TIMEZONE,
    events,
  };
}

export interface GLSFranceTrackerOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class GLSFranceTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: GLSFranceTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('GLS France timeout must be positive');
    }
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const normalized = normalizeGLSFranceTrackingNumber(trackingNumber);
    const printed = printedNumber(trackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    try {
      return await this.lookup(normalized, normalized, budget);
    } catch (error) {
      // The 11-digit parcel number is what GLS keys a parcel by. Should the
      // French backend only know the number as printed, ask for it once too.
      if (printed === normalized || !(error instanceof UpstreamHttpError) || error.status !== 404) throw error;
      return await this.lookup(printed, normalized, budget);
    }
  }

  private async lookup(code: string, normalized: string, budget: LookupBudget): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${TRACKING_API}/${encodeURIComponent(code)}`, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Origin: 'https://moncolis.gls-france.com',
        Referer: `${TRACKING_PAGE}/`,
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: 'GLS France tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      fetcher: this.#fetcher,
      allowHttpStatuses: [404, 410],
    });
    budget.signal.throwIfAborted();
    if ([404, 410].includes(response.status)) {
      // The native negative names the complete submitted code. An absent API
      // route or gateway response says nothing about the parcel.
      if (response.status === 404 && decodeText(bytes).trim() === `404 No command found for code: ${code}`) {
        throw new UpstreamHttpError('GLS France tracking', 404);
      }
      throw new TransportError(PROVIDER, 'GLS France tracking endpoint is unavailable', { status: response.status });
    }
    return parseGLSFranceTrackingResponse(parseJsonBytes(bytes, PROVIDER), normalized);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSFranceTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'gls-fr',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(
      () => tracker.fetch(number, context),
      () => accepted(() => normalizeGLSFranceTrackingNumber(number)),
    ),
  };
};
