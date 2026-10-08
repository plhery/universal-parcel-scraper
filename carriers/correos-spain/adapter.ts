
import { lookupBudget, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isCorreosSpainExpeditionCode } from '../../core/detection/correosSpain.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyCorreosSpainStatus } from './status.js';

// Protocol provenance:
// - Prior art (structure + vocabulary, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-correos (api.py, parcels.py,
//   tests/payloads.py — keyless localizador endpoint, codError envelope,
//   event shape, Europe/Madrid split timestamps, full status map).
// - Live verification 2026-09-10: unknown codes answer HTTP 200 with
//   [0].error.codError "3" (Sin Trazabilidad en Minerva) and eventos:null.
//   The transport status is always 200; only the envelope decides.
// - Success shape confirmed against a real ES parcel 2026-08-24 by the
//   prior-art client (admitted → classified → out-for-delivery → failed
//   attempt → office hold → collected); the map lives in status.ts.
const TRACKING_ENDPOINT = 'https://localizador.correos.es/canonico/eventos_envio_servicio';
// The localizador only knows parcel codes. The public tracker's own search
// names the parcels of an expedition code, and answers 204 for an unknown one.
const EXPEDITION_ENDPOINT = 'https://api1.correos.es/digital-services/searchengines/api/v1/envios';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `fetchBounded` repeats a request that failed in transit once, after this pause. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;

function parsedTime(dateValue: unknown, timeValue: unknown): { iso: string; timestamp: number } | null {
  const date = clean(dateValue, 16);
  if (!date) return null;
  // Correos splits timestamps into fecEvento (DD/MM/YYYY) and horEvento
  // (HH:MM:SS, midnight when absent) in Spanish local time. Mainland Spain is
  // Europe/Madrid; Canary Islands scans stamped the same way can be off by one
  // hour — documented here rather than solved, as events carry no locality.
  return zonedTime(
    `${date} ${clean(timeValue, 16) || '00:00:00'}`,
    'dd/MM/yyyy HH:mm:ss',
    'Europe/Madrid',
    { locale: 'es-ES' },
  );
}

export function normalizeCorreosSpainTrackingNumber(raw: string): string {
  // The localizador accepts any Correos-issued code (S10 ES, PQ domestic,
  // PR-prefixed); the codError envelope — not the shape — decides unknown.
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{4,40}$/.test(value) || !/\d/.test(value)) {
    throw new InvalidInputError('Correos', 'Correos tracking requires a tracking code with letters, numbers and a digit');
  }
  return value;
}

export function correosSpainTrackingUrl(rawTrackingNumber: string): string {
  const url = new URL('https://www.correos.es/es/es/herramientas/localizador/envios/detalle');
  url.searchParams.set('tracking-number', normalizeCorreosSpainTrackingNumber(rawTrackingNumber));
  return url.toString();
}

const code = (value: unknown) => clean(value, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');

/**
 * The parcel code behind an expedition code, from the public tracker's search.
 * An expedition of several parcels has no single history: it stays inconclusive.
 */
export function parseCorreosSpainExpeditionResponse(payload: unknown, expeditionCode: string): string {
  const requested = normalizeCorreosSpainTrackingNumber(expeditionCode);
  const shipments: unknown = isRecord(payload) ? payload.shipment : undefined;
  if (!Array.isArray(shipments) || !shipments.every(isRecord)) {
    throw new SchemaError('Correos', 'Correos returned an invalid expedition response');
  }
  const parcels = new Set(shipments.filter((shipment) => code(shipment.expeditionCode) === requested)
    .map((shipment) => code(shipment.shipmentCode)));
  if (parcels.size === 0) throw new SchemaError('Correos', 'Correos returned a different expedition');
  if (parcels.size > 1) throw new IndeterminateError('Correos', 'Correos expedition holds several parcels');
  const [parcel] = parcels;
  if (!parcel || !/^[A-Z0-9]{4,40}$/.test(parcel)) {
    throw new SchemaError('Correos', 'Correos did not return the expedition parcel');
  }
  return parcel;
}

/** `expeditionCode` binds a parcel found through its expedition to that expedition. */
export function parseCorreosSpainTrackingResponse(payload: unknown, trackingNumber: string, expeditionCode?: string): CarrierResult {
  const requested = normalizeCorreosSpainTrackingNumber(trackingNumber);
  // The endpoint answers a single-element array; bare objects are accepted too
  // since some error bodies come back unwrapped.
  const envelope: unknown = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(envelope)) throw new SchemaError('Correos', 'Correos returned an invalid tracking response');
  const returned = code(envelope.codEnvio);
  if (!returned) throw new SchemaError('Correos', 'Correos did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('Correos', 'Correos returned a different shipment');
  if (expeditionCode !== undefined && code(envelope.codExpedicion) !== normalizeCorreosSpainTrackingNumber(expeditionCode)) {
    throw new SchemaError('Correos', 'Correos returned a parcel of a different expedition');
  }
  const error = envelope.error;
  if (!isRecord(error) || (typeof error.codError !== 'string'
    && (typeof error.codError !== 'number' || !Number.isFinite(error.codError)))) {
    throw new SchemaError('Correos', 'Correos returned a response without a result envelope');
  }
  // Any non-zero codError (e.g. "3" Sin Trazabilidad) means unknown or
  // not-yet-scanned: a domain outcome, never a transport failure.
  if (String(error.codError) !== '0') throw new NotFoundError('Correos');
  const rawEvents = envelope.eventos;
  if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
    throw new SchemaError('Correos', 'Correos returned invalid tracking history');
  }
  const parsed: Array<{ event: CarrierEvent; classified: ClassifiedStatus | undefined; timestamp: number; index: number }> = [];
  const seen = new Set<string>();
  (Array.isArray(rawEvents) ? rawEvents : []).filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const code = clean(rawEvent.codEvento, 32).toLocaleUpperCase('en-US');
    // desTextoResumen is the backend's fixed Spanish wording.
    const description = clean(rawEvent.desTextoResumen, 500) || code;
    const time = parsedTime(rawEvent.fecEvento, rawEvent.horEvento);
    if (!time || !description) return;
    const identity = `${time.iso}\u0000${description}\u0000${code}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyCorreosSpainStatus(code);
    parsed.push({
      // An unmapped code keeps no stage: the sync classifies the wording and
      // records where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: '',
        description,
        ...(classified ? { stage: classified.stage } : {}),
      },
      classified,
      timestamp: time.timestamp,
      index,
    });
  });
  // The localizador lists oldest first; the parcel state is the latest entry.
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const latest = parsed[0];
  // Office name (nom_codired), weight (peso grams) and dimensions travel on
  // the envelope. The office is only a pickup signal when the parcel is
  // actually awaiting collection; weight/dims are operational parcel data.
  const office = clean(envelope.nom_codired, 300) || null;
  const grams = Number(envelope.peso);
  const weightKg = Number.isFinite(grams) && grams > 0 ? Math.round((grams / 1000) * 1000) / 1000 : null;
  const dims = [envelope.largo, envelope.ancho, envelope.alto].map((value) => Number(value));
  // Sides are centimetres, except on some international items that give metres:
  // no parcel is under a centimetre on every side.
  const sides = dims.every((value) => value < 1) ? dims.map((value) => Math.round(value * 1000) / 10) : dims;
  const dimensionsText = dims.every((value) => Number.isFinite(value) && value > 0)
    ? `${sides[0]} x ${sides[1]} x ${sides[2]} cm` : null;
  // nombre_cliente names a person in the doorstep case, so it is never
  // projected; weight and dimensions are operational parcel data.
  const extras = {
    ...(weightKg != null ? { weight_kg: weightKg } : {}),
    ...(dimensionsText ? { dimensions_text: dimensionsText } : {}),
  };
  const pickupExtras = (stage?: string): Record<string, string> => (
    stage === 'ready_for_pickup' && office ? { pickup_point: office } : {}
  );
  if (!latest) {
    return {
      status: 'unknown',
      last_status_text: clean(envelope.resumen_ultimo, 500) || 'Tracking information received',
      last_update: null,
      expected_delivery: null,
      ...extras,
      events,
    };
  }
  if (!latest.classified) {
    return {
      status: 'unknown',
      last_status_text: latest.event.description,
      last_update: latest.event.time ?? null,
      expected_delivery: null,
      ...extras,
      ...pickupExtras(latest.event.stage),
      events,
    };
  }
  const deliveredAt = latest.classified.status === 'delivered' ? latest.event.time ?? null : null;
  return {
    status: latest.classified.status,
    current_stage: latest.classified.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    expected_delivery: null,
    ...extras,
    ...pickupExtras(latest.classified.stage),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events,
  };
}

export class CorreosSpainTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    this.userAgent = userAgentOf(options.userAgent);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Correos tracking timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeCorreosSpainTrackingNumber(rawTrackingNumber);
    const expedition = isCorreosSpainExpeditionCode(trackingNumber);
    // The default budget covers each request, its pause and its one transient retry.
    const budget = lookupBudget(context, (expedition ? 2 : 1) * (2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS));
    const request = async (url: string) => {
      const { response, bytes } = await fetchBounded(url, {
        signal: budget.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': this.userAgent,
        },
      }, {
        provider: 'Correos tracking',
        timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
        maxBytes: MAX_RESPONSE_BYTES,
        retryTransient: true,
        allowHttpError: true,
        fetcher: this.fetcher,
      });
      if (!response.ok) throw new UpstreamHttpError('Correos tracking', response.status);
      return { response, bytes };
    };
    let parcel = trackingNumber;
    if (expedition) {
      const found = await request(`${EXPEDITION_ENDPOINT}?${new URLSearchParams({ text: trackingNumber, language: 'ES' })}`);
      if (found.response.status === 204) throw new NotFoundError('Correos');
      parcel = parseCorreosSpainExpeditionResponse(parseJsonBytes(found.bytes, 'Correos tracking'), trackingNumber);
    }
    const { bytes } = await request(`${TRACKING_ENDPOINT}/${encodeURIComponent(parcel)}`
      + '?codAplicacion=60&codCanal=3&codIdioma=ES&indUltEvento=N');
    // A code the search returns as its own parcel is tracked as any parcel code.
    return parseCorreosSpainTrackingResponse(parseJsonBytes(bytes, 'Correos tracking'), parcel,
      parcel === trackingNumber ? undefined : trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosSpainTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'correos-spain',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
