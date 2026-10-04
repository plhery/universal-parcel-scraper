import { validateDachserTrackingUrl } from '../../core/catalog/urls.js';
export { validateDachserTrackingUrl } from '../../core/catalog/urls.js';
import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { InputRequiredError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { eventLabel, plainText, shipmentStatus } from './status.js';

const DACHSER_HOST = 'customeriberia.dachser.com';
const DACHSER_PAGE_PATH = '/customerarea/utilidades/seguimiento-publico/detalle';
const DACHSER_API_PATH = '/api/utilidades/seguimiento-publico/detalle';
const PROVIDER = 'Dachser';
const DEFAULT_TIMEOUT_MS = 15_000;
const DATE_FORMATS = [
  'dd/MM/yyyy HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy',
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm',
  'yyyy-MM-dd',
];

export interface DachserOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
}

function normalizeTrackingNumber(raw: unknown): string {
  return String(raw ?? '').replace(/[\s.-]/g, '').toUpperCase();
}

/**
 * Validate and canonicalize a pasted Dachser capability URL.
 *
 * The host's `carriers.ts` calls this when a parcel is created or edited, so
 * the failures below are user-facing input errors, not provider errors. The
 * URL's query parameters grant access to the shipment: treat the whole string
 * like a password.
 */


export function dachserApiUrl(trackingUrl: string, trackingNumber: string): string {
  const url = new URL(validateDachserTrackingUrl(trackingUrl, trackingNumber));
  url.pathname = DACHSER_API_PATH;
  return url.toString();
}

/**
 * Local time policy: the endpoint mixes ISO-8601 with `dd/MM/yyyy [HH:mm[:ss]]`
 * and `yyyy-MM-dd [HH:mm[:ss]]`, all of them wall-clock times in Spain. Values
 * that do carry an offset keep it; everything else is read in Europe/Madrid.
 */
function parseDateTime(raw: unknown): DateTime | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed = DateTime.fromISO(value, { zone: 'Europe/Madrid', setZone: true });
  if (!parsed.isValid) {
    for (const format of DATE_FORMATS) {
      parsed = DateTime.fromFormat(value, format, { zone: 'Europe/Madrid' });
      if (parsed.isValid) break;
    }
  }
  return parsed.isValid ? parsed : null;
}

export function parseDachserTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Dachser returned an invalid tracking response');
  if (!payload.numUnico) throw new SchemaError(PROVIDER, 'Dachser did not return a shipment number');
  if (normalizeTrackingNumber(payload.numUnico) !== normalizeTrackingNumber(trackingNumber)) {
    throw new SchemaError(PROVIDER, 'Dachser returned a different shipment');
  }

  const sourceEvents = Array.isArray(payload.incidenciaExpedicionData)
    ? payload.incidenciaExpedicionData
    : [];
  const events: Array<{ time: string; location: string; stage: string; description: string }> = [];
  const seen = new Set<string>();
  for (const sourceEvent of sourceEvents.slice(0, 200)) {
    if (!isRecord(sourceEvent)) continue;
    const occurred = parseDateTime(sourceEvent.fechaIncidencia);
    if (!occurred) continue;
    const label = eventLabel(sourceEvent.descripcionIncidencia);
    const timestamp = occurred.toISO({ suppressMilliseconds: true })!;
    const identity = JSON.stringify([timestamp, label.stage, label.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push({ time: timestamp, location: '', ...label });
  }
  events.sort((left, right) => right.time.localeCompare(left.time));

  const status = shipmentStatus(payload.estadoExpedicion, events.length > 0);
  const lastUpdate = parseDateTime(payload.fechaEstado) ?? parseDateTime(events[0]?.time);
  let expectedDelivery: string | null = null;
  if (status.status !== 'delivered') {
    for (const field of ['fechaEntregaAplazada', 'fCompromiso', 'fechaPrimeraEntrega']) {
      const value = parseDateTime(payload[field]);
      if (value) {
        expectedDelivery = value.toISODate();
        break;
      }
    }
  }
  return {
    status: status.status,
    last_status_text: status.text,
    last_update: lastUpdate?.toISO({ suppressMilliseconds: true }) ?? null,
    expected_delivery: expectedDelivery,
    timezone: 'Europe/Madrid',
    events,
  };
}

export class DachserTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;

  constructor(options: number | DachserOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher } = typeof options === 'number'
      ? { timeoutMs: options, fetcher: undefined }
      : options;
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
  }

  async fetch(trackingNumber: string, trackingUrl: string): Promise<CarrierResult> {
    const { bytes, response } = await fetchBounded(dachserApiUrl(trackingUrl, trackingNumber), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
        Referer: `https://${DACHSER_HOST}${DACHSER_PAGE_PATH}`,
        'User-Agent': 'SwissDeliveryTracker/1.0',
      },
    }, {
      provider: 'Dachser tracking',
      timeoutMs: this.timeoutMs,
      allowHttpError: true,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) throw new NotFoundError(PROVIDER);
      let errorPayload: unknown;
      try {
        errorPayload = parseJsonBytes(bytes, PROVIDER);
      } catch {
        throw new UpstreamHttpError('Dachser tracking', response.status);
      }
      // An unknown shipment/access tuple reaches a null result in Dachser's
      // public endpoint and surfaces as a JSON 500 whose message names it.
      // ERR_APP_500 is the endpoint's catch-all for any unhandled exception and
      // the message is the only field that says which one, so the `message: null`
      // reply the same tuple also gets stays an operational failure, like every
      // unrelated 500, rather than a false not-found.
      const errorMessage = plainText(isRecord(errorPayload) ? errorPayload.message ?? '' : '');
      if (
        response.status === 500
        && isRecord(errorPayload)
        && errorPayload.code === 'ERR_APP_500'
        && errorPayload.path === DACHSER_API_PATH
        && errorMessage.includes('resultadodetexp')
        && errorMessage.includes('null')
      ) throw new NotFoundError(PROVIDER);
      throw new UpstreamHttpError('Dachser tracking', response.status);
    }
    return parseDachserTrackingResponse(parseJsonBytes(bytes, PROVIDER), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DachserTracker({ fetcher: environment.fetcher });
  return {
    id: 'dachser',
    steps: ['direct'],
    track: async (input) => {
      if (!input.trackingUrl) {
        throw new InputRequiredError(PROVIDER, 'its complete tracking URL',
          'Dachser tracking requires its complete tracking URL');
      }
      return tracker.fetch(input.number, input.trackingUrl);
    },
  };
};
