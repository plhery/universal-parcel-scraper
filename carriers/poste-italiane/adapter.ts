
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isPosteItalianeTrackingNumber } from '../../core/detection/posteItaliane.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { clean, fetchBounded, parseJsonBytes, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyPosteItalianeStatus } from './status.js';

// Protocol provenance:
// - Prior art (structure + vocabulary, verified independently below, MIT):
//   https://github.com/ha-parcel-integrations/ha-poste-italiane (api.py,
//   parcels.py status map, tests/payloads.py — keyless DoveQuando endpoint,
//   esitoRicerca envelope, epoch-millis dataOra, Europe/Rome ETA text).
// - Live verification 2026-09-10: unknown codes answer HTTP 200 with
//   esitoRicerca "1"; old expired parcels answer without esitoRicerca and
//   with empty listaMovimenti. The success vocabulary in status.ts was
//   confirmed against a real parcel 2026-08-24 by the prior-art client.
// - Deep link verified live in a real browser session: .../cerca/index.html
//   #/risultati-spedizioni/{code} resolves the code and renders the tracker
//   (expired parcels show the documented "Tracciatura non disponibile").
const TRACKING_ENDPOINT = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `fetchBounded` repeats a request that failed in transit once, after this pause. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;

const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

function expectedDeliveryDay(value: unknown): string | null {
  // dataPrevistaConsegna reads like "Consegna prevista entro Giovedì 1 Gennaio
  // 2026": reduce it to the local calendar day, never a timestamp.
  if (typeof value !== 'string') return null;
  // Note: \w is ASCII-only in JS without the u flag and would choke on accented
  // weekday names like "Venerdì", so the weekday group excludes spaces/digits
  // instead (Python's \w would have matched; kept equivalent here).
  const match = /(?:consegna prevista(?: entro)?\s+)(?:[^\s\d]+\s+)?(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i.exec(value);
  if (!match) return null;
  const month = ITALIAN_MONTHS[match[2]!.toLocaleLowerCase('it-IT')];
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * dataOra is epoch milliseconds (numbers, occasionally numeric strings).
 * `core/time`'s epochMillisTime suppresses milliseconds in its ISO output;
 * this adapter has always emitted them, and the value is persisted, so the
 * local helper stays rather than silently rewriting stored timestamps.
 */
function parsedTime(value: unknown): { iso: string; timestamp: number } | null {
  const millis = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return { iso, timestamp: millis };
}

/**
 * A depot scan's place is a town and its province, as "PESCARA (PE)" or
 * "NAPOLI NA", and a delivery reads "dalla sede operativa di" that town. Any
 * other place, such as a post office's street address or a street named with
 * its province, stays out.
 */
const STREET = /^(?:VIA|VIALE|VICOLO|PIAZZA|PIAZZALE|PIAZZETTA|CORSO|LARGO|STRADA|LUNGOMARE|LUNGOTEVERE|CONTRADA|LOCALIT(?:À|A'?)|FRAZIONE|SALITA)(?:\s|$)/u;
function townLabel(value: unknown): string {
  const text = clean(value, 120).replace(/^dalla sede operativa di\s+/u, '');
  const match = /^([A-ZÀ-Ý][A-ZÀ-Ý' .-]{1,40}?)\s+(?:\(([A-Z]{2})\)|([A-Z]{2}))$/u.exec(text);
  return match && !STREET.test(match[1]!) ? `${match[1]} (${match[2] ?? match[3]})` : '';
}

/** The product the parcel travels under; letter-post items echo their own number instead. */
function serviceName(value: unknown, trackingNumber: string): string {
  const text = clean(value, 80);
  return /^[\p{L}][\p{L}\d '+.&-]{2,59}$/u.test(text) && !/\d{6}/.test(text)
    && text.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '') !== trackingNumber ? text : '';
}

export function normalizePosteItalianeTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!isPosteItalianeTrackingNumber(value)) {
    throw new InvalidInputError('Poste Italiane', 'Poste Italiane tracking requires a Poste Italiane parcel identifier');
  }
  return value;
}

export function posteItalianeTrackingUrl(rawTrackingNumber: string): string {
  return `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(normalizePosteItalianeTrackingNumber(rawTrackingNumber))}`;
}

export function parsePosteItalianeTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizePosteItalianeTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Poste Italiane', 'Poste Italiane returned an invalid tracking response');
  const returned = clean(payload.idTracciatura, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!returned) throw new SchemaError('Poste Italiane', 'Poste Italiane did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('Poste Italiane', 'Poste Italiane returned a different shipment');
  const esito = clean(payload.esitoRicerca, 8);
  // Native negative outcomes remain distinct from HTTP endpoint failures.
  if (esito === '1' || esito === '2') throw new NotFoundError('Poste Italiane');
  if (Object.hasOwn(payload, 'esitoRicerca') && esito !== '3') {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned an invalid result envelope');
  }
  const rawMovements = payload.listaMovimenti;
  if (!Array.isArray(rawMovements)) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned invalid tracking history');
  }
  const parsed: Array<{
    event: CarrierEvent; classified: ClassifiedStatus | undefined; returnTrip: boolean | undefined; timestamp: number; index: number;
  }> = [];
  const seen = new Set<string>();
  rawMovements.filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const wording = clean(rawEvent.statoLavorazione, 500);
    const time = parsedTime(rawEvent.dataOra);
    if (!time || !wording) return;
    const identity = `${time.iso}\u0000${wording}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyPosteItalianeStatus(rawEvent.statoLavorazione);
    parsed.push({
      // A post-office scan names its office, which becomes the location; the
      // office's address, postcode and hours are not kept. Other scans keep
      // luogo only when it is a town and province. Sender, dimensions and
      // pickup-office blocks on the envelope are never retained either.
      // Unmapped wording keeps no stage: the sync classifies it and records
      // where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: clean(rawEvent.denominazioneUfficio, 80) || townLabel(rawEvent.luogo),
        description: wording,
        ...(classified ? { stage: classified.stage } : {}),
      },
      classified: classified ?? undefined,
      returnTrip: typeof rawEvent.flagRitorno === 'boolean' ? rawEvent.flagRitorno : undefined,
      timestamp: time.timestamp,
      index,
    });
  });
  // Movements come oldest first, so of two sharing an instant the later one is newer.
  parsed.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const service = serviceName(payload.tipoProdotto, requested);
  const product = service ? { service_name: service } : {};
  if (rawMovements.length > 0 && events.length === 0) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned unusable tracking history');
  }
  // Envelope stato "5" forces delivered; otherwise the newest mapped event wins
  // and unmapped wording stays unknown with its raw text preserved.
  if (payload.stato === '5' || payload.stato === 5) {
    // A parcel sent back ends with its delivery to the sender. That delivery
    // carries the return flag; without per-movement flags, the envelope flag
    // and an earlier return scan say the same.
    const newest = parsed[0];
    const backToSender = newest?.returnTrip
      ?? (payload.flagRitorno === true && parsed.slice(1).some((item) => item.classified?.stage === 'returned'));
    return {
      status: backToSender ? 'exception' : 'delivered',
      current_stage: backToSender ? 'returned' : 'delivered',
      last_status_text: events[0]?.description ?? 'Delivered',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      ...product,
      events,
    };
  }
  const latest = parsed.find((item) => item.classified);
  if (!latest) {
    if (events.length > 0) {
      // Movements exist but none map: report unknown with the newest raw
      // wording preserved rather than a wrong status or a false pending.
      return {
        status: 'unknown',
        last_status_text: events[0]!.description,
        last_update: events[0]?.time ?? null,
        expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
        ...product,
        events,
      };
    }
    if (esito === '3') {
      return {
        status: 'pending',
        current_stage: 'registered',
        last_status_text: 'Tracking information received',
        last_update: null,
        expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
        ...product,
        events,
      };
    }
    // The observed expired parcel carries a native parcel type and an explicit
    // empty movement array, with no search outcome. An echoed identifier alone
    // or another unrecognized envelope is not this negative contract.
    if (!Object.hasOwn(payload, 'esitoRicerca') && payload.tipoSpedizione === 'P') {
      throw new NotFoundError('Poste Italiane');
    }
    throw new IndeterminateError('Poste Italiane', 'Poste Italiane returned no shipment activity or native result');
  }
  return {
    status: latest.classified!.status,
    current_stage: latest.classified!.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    expected_delivery: expectedDeliveryDay(payload.dataPrevistaConsegna),
    ...product,
    events,
  };
}

export class PosteItalianeTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Poste Italiane tracking timeout must be positive');
    }
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizePosteItalianeTrackingNumber(rawTrackingNumber);
    // The default budget covers the request, the pause and the one transient retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    const { response, bytes } = await fetchBounded(TRACKING_ENDPOINT, {
      method: 'POST',
      signal: budget.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://www.poste.it',
        Referer: 'https://www.poste.it/',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify({ codiceSpedizione: trackingNumber, tipoRichiedente: 'WEB', periodoRicerca: 1 }),
    }, {
      provider: 'Poste Italiane tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    budget.signal.throwIfAborted();
    if ([404, 410].includes(response.status)) {
      throw new TransportError('Poste Italiane', 'Poste Italiane tracking endpoint is unavailable', {
        cause: new UpstreamHttpError('Poste Italiane tracking', response.status),
      });
    }
    if (!response.ok) throw new UpstreamHttpError('Poste Italiane tracking', response.status);
    return parsePosteItalianeTrackingResponse(parseJsonBytes(bytes, 'Poste Italiane tracking'), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PosteItalianeTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'poste-italiane',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizePosteItalianeTrackingNumber(number))),
  };
};
