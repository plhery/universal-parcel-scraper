import { DateTime } from 'luxon';
import { fetchPosteItalianeInBrowser } from './browser.js';
import { SengiExpressTracker } from '../sengi-express/adapter.js';

import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isPosteItalianeLookup } from '../../core/detection/posteItaliane.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, ImportCharges } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { clean, EgressPacer, egressesOf, fetchBounded, parseJsonBytes, UpstreamHttpError, userAgentOf, type Egress } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { budgetWhenOutOfTime, type TrawlClient } from '../../core/transport/trawl.js';
import { classifyPosteItalianeStatus, keepsPosteItalianeStage, posteItalianeMovementWording, posteItalianeUncollected } from './status.js';

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
// Guest request in the official com.posteitaliane.spim app; no account header is needed.
const APP_TRACKING_ENDPOINT = 'https://www.poste.it/online/dovequando/DQ-REST-TRUSTED/ricercasemplice';
const DEFAULT_TIMEOUT_MS = 15_000;
/** `fetchBounded` repeats a request that failed in transit once, after this pause. */
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVENTS_TO_RETURN = 20;
/** A `5P` code, which SENGI Express's line from China to Poste ("PI") gives a parcel before Poste has it. */
const SENGI_LINE_CODE = /^5P[A-Z0-9]{11}$/;
/** The most of a lookup's budget SENGI Express's tracker gets. */
const SENGI_BUDGET_MS = 15_000;

/** SENGI Express's lookup of a code its line to Poste carries. */
export type PosteItalianeSengiLookup = (number: string, context: TrackingContext) => Promise<CarrierResult>;

const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

/** The day of the round a scan puts the parcel on, on Italy's clock. */
function roundDay(event: CarrierEvent): string | null {
  if (typeof event.time !== 'string') return null;
  const day = DateTime.fromISO(event.time, { setZone: true }).setZone('Europe/Rome');
  return day.isValid ? day.toISODate() : null;
}

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
 * its province, stays out. The country follows the province, which would
 * otherwise read as one: "TORINO (TO)" is not in Tonga.
 */
const STREET = /^(?:VIA|VIALE|VICOLO|PIAZZA|PIAZZALE|PIAZZETTA|CORSO|LARGO|STRADA|LUNGOMARE|LUNGOTEVERE|CONTRADA|LOCALIT(?:À|A'?)|FRAZIONE|SALITA)(?:\s|$)/u;
function townLabel(value: unknown): string {
  const text = clean(value, 120).replace(/^dalla sede operativa di\s+/u, '');
  const match = /^([A-ZÀ-Ý][A-ZÀ-Ý' .-]{1,40}?)\s+(?:\(([A-Z]{2})\)|([A-Z]{2}))$/u.exec(text);
  return match && !STREET.test(match[1]!) ? `${match[1]} (${match[2] ?? match[3]}), IT` : '';
}

/** The product the parcel travels under; letter-post items echo their own number instead. */
function serviceName(value: unknown, trackingNumber: string): string {
  const text = clean(value, 80);
  return /^[\p{L}][\p{L}\d '+.&-]{2,59}$/u.test(text) && !/\d{6}/.test(text)
    && text.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '') !== trackingNumber ? text : '';
}

// Poste's import charges, in euro cents: customs duty and VAT together, and its own
// clearance fee as paid on delivery and as paid online beforehand ("Smart"), which the
// fee table on its page for receiving from abroad prices at €21.00 and €18.00 above €150.
const CHARGES = { customs: 'importoDirittiDoganali', carrier_fee: 'importoDirittiPostali', carrier_fee_online: 'importoDirittiPostaliSmart' } as const;

/** The import charges an item from outside the EU owes, as `oneri` lists them. */
function importCharges(value: unknown): { import_charges: ImportCharges } | Record<string, never> {
  if (!isRecord(value)) return {};
  const charges: ImportCharges = { currency: 'EUR' };
  for (const [field, key] of Object.entries(CHARGES) as Array<[keyof typeof CHARGES, string]>) {
    const cents = clean(value[key], 12);
    if (/^\d{1,9}$/.test(cents)) charges[field] = Number(cents) / 100;
  }
  // PAGATO is paid. FINESTRA_PAGAMENTO_CHIUSA closes the online payment window: what is
  // left is paid on delivery, so the online price no longer applies. It says nothing sure
  // about payment, and stays a code like any other.
  const status = clean(value.statoOneri, 60);
  if (status === 'PAGATO') charges.paid = true;
  if (status === 'FINESTRA_PAGAMENTO_CHIUSA') delete charges.carrier_fee_online;
  if (/^[A-Z][A-Z_]*$/.test(status)) charges.status_code = status;
  return Object.keys(charges).length > 1 ? { import_charges: charges } : {};
}

/**
 * How many searches one egress sends in a minute. The app route sits behind a firewall that answers
 * an address searching about thirty times a minute with HTTP 429 for a minute or two; this stays
 * well under it.
 */
export const SEARCHES_PER_MINUTE = 15;
/** How long an egress the service refused with an HTTP 429 naming no wait sends nothing. */
export const REFUSED_PAUSE_MS = 2 * 60_000;
/**
 * How long after a CAPTCHA no search is sent through that egress. The web tracker asks for it
 * after every twenty searches from an address.
 */
export const CAPTCHA_PAUSE_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * The turns of every egress, shared by every tracker in the process, recognition included: the
 * service counts an address's searches. A restart forgets them.
 */
const SEARCHES = new EgressPacer('Poste Italiane', { reads: SEARCHES_PER_MINUTE, windowMs: 60_000, pauseMs: REFUSED_PAUSE_MS });

/** The wait an HTTP 429 names in its Retry-After, in seconds or as a date, at most an hour; undefined when it names none. */
function retryAfterMs(retryAfter: string | null | undefined): number | undefined {
  const value = retryAfter?.trim() ?? '';
  const named = /^\d+$/.test(value) ? Number(value) * 1000 : DateTime.fromHTTP(value).toMillis() - Date.now();
  return Number.isFinite(named) ? Math.min(Math.max(named, 0), HOUR_MS) : undefined;
}

/**
 * After every twenty searches from one address, the service refuses the next two with HTTP 400
 * and an error envelope asking for its CAPTCHA.
 */
function captchaRequired(bytes: Uint8Array): boolean {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(payload) && payload.tipo === 'error' && /captcha/i.test(clean(payload.descrizione, 200));
  } catch {
    return false;
  }
}

export function normalizePosteItalianeTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!isPosteItalianeLookup(value)) {
    throw new InvalidInputError('Poste Italiane', 'Poste Italiane tracking requires a Poste Italiane identifier or a postal S10 number');
  }
  return value;
}

export function posteItalianeTrackingUrl(rawTrackingNumber: string): string {
  return `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(normalizePosteItalianeTrackingNumber(rawTrackingNumber))}`;
}

/** The envelope's addressee and their address, as Poste writes them. */
function recipientOf(payload: Record<string, unknown>): Pick<CarrierResult, 'receiver_name' | 'receiver_address'> {
  const name = clean(payload.destinatario, 120);
  const address = clean(payload.indirizzoDestinatario, 300);
  return { ...(name ? { receiver_name: name } : {}), ...(address ? { receiver_address: address } : {}) };
}

/** Who signed for a delivery, as the envelope names them. */
function signerOf(payload: Record<string, unknown>): Pick<CarrierResult, 'signed_by'> {
  const signer = clean(payload.firmaDestinatario, 120);
  return signer ? { signed_by: signer } : {};
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
  // A letter-post code Poste does not know, such as one whose check digit fails, answers as
  // letter post (tipoSpedizione C) at stato 1 with neither a product nor a movement list.
  if (esito === '3' && payload.tipoSpedizione === 'C' && clean(payload.stato, 8) === '1'
    && !Object.hasOwn(payload, 'listaMovimenti') && !Object.hasOwn(payload, 'tipoProdotto')) {
    throw new NotFoundError('Poste Italiane');
  }
  if (!Array.isArray(rawMovements)) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned invalid tracking history');
  }
  const parsed: Array<{
    event: CarrierEvent; classified: ClassifiedStatus | undefined; returnTrip: boolean | undefined; timestamp: number; index: number;
  }> = [];
  const seen = new Set<string>();
  // Mail from abroad was accepted by its sending post: Poste's intake is its receipt from that post, on the way.
  const abroad = isValidS10TrackingNumber(requested) && !requested.endsWith('IT');
  // Movements come oldest first: whether the parcel already waited for its recipient at a pickup point.
  let waited = false;
  let previous: ClassifiedStatus | undefined;
  rawMovements.filter(isRecord).slice(0, 500).forEach((rawEvent, index) => {
    const wording = posteItalianeMovementWording(clean(rawEvent.statoLavorazione, 500), rawEvent.box);
    const time = parsedTime(rawEvent.dataOra);
    if (!time || !wording) return;
    const identity = `${time.iso}\u0000${wording}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    // A notice, such as changed delivery instructions, keeps the stage of the scan before it.
    const kept = keepsPosteItalianeStage(wording) ? previous : undefined;
    let classified = kept || keepsPosteItalianeStage(wording) ? undefined
      : posteItalianeUncollected(wording, waited) ?? classifyPosteItalianeStatus(wording);
    if (abroad && classified?.stage === 'accepted') classified = { status: 'in_transit', stage: 'in_transit' };
    if (classified?.stage === 'ready_for_pickup') waited = true;
    previous = classified ?? previous;
    parsed.push({
      // A post-office scan names its office, which becomes the location; the
      // office's address, postcode and hours are not kept. Other scans keep
      // luogo only when it is a town and province. Sender, weight, dimensions
      // and pickup-office blocks on the envelope are never retained either.
      // Unmapped wording keeps no stage: the sync classifies it and records
      // where the stage came from instead of assuming movement here.
      event: {
        time: time.iso,
        location: clean(rawEvent.denominazioneUfficio, 80) || townLabel(rawEvent.luogo),
        description: wording,
        ...(classified ? { stage: classified.stage } : kept ? { stage: kept.stage, stage_source: 'none' } : {}),
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
  const facts = { ...(service ? { service_name: service } : {}), ...importCharges(payload.oneri), ...recipientOf(payload) };
  if (rawMovements.length > 0 && events.length === 0) {
    throw new SchemaError('Poste Italiane', 'Poste Italiane returned unusable tracking history');
  }
  // A return after the newest delivery outranks it: a parcel left at a pickup
  // point and not collected goes back to the sender.
  const delivery = parsed.findIndex((item) => item.classified?.stage === 'delivered');
  const returnedSince = delivery > 0
    && parsed.slice(0, delivery).some((item) => item.returnTrip === true || item.classified?.stage === 'returned');
  const sentBack = (): CarrierResult => ({
    status: 'exception',
    current_stage: 'returned',
    last_status_text: events[0]?.description ?? 'Returned',
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...facts,
    events,
  });
  // Envelope stato "5" forces delivered; otherwise the newest mapped event wins
  // and unmapped wording stays unknown with its raw text preserved.
  if (payload.stato === '5' || payload.stato === 5) {
    // A parcel sent back ends with its delivery to the sender. That delivery
    // carries the return flag; without per-movement flags, the envelope flag
    // and an earlier return scan say the same.
    const newest = parsed[0];
    const backToSender = returnedSince || (newest?.returnTrip
      ?? (payload.flagRitorno === true && parsed.slice(1).some((item) => item.classified?.stage === 'returned')));
    if (backToSender) return sentBack();
    return {
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: events[0]?.description ?? 'Delivered',
      last_update: events[0]?.time ?? null,
      expected_delivery: null,
      ...facts,
      ...signerOf(payload),
      events,
    };
  }
  if (returnedSince) return sentBack();
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
        ...facts,
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
        ...facts,
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
  // A delivery or return the envelope has not caught up with ends the estimate too. The estimate is a
  // deadline ("entro"): a parcel out for delivery is due on its round's day, in Italy, not by the deadline.
  const final = latest.classified!.stage === 'delivered' || latest.classified!.stage === 'returned';
  const round = latest.classified!.stage === 'out_for_delivery' ? roundDay(latest.event) : null;
  return {
    status: latest.classified!.status,
    current_stage: latest.classified!.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    expected_delivery: final ? null : round ?? expectedDeliveryDay(payload.dataPrevistaConsegna),
    ...facts,
    ...(latest.classified!.stage === 'delivered' ? signerOf(payload) : {}),
    events,
  };
}

export class PosteItalianeTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private readonly userAgent: string;

  constructor(private readonly options: { timeoutMs?: number; fetcher?: typeof fetch; userAgent?: string; trawl?: TrawlClient | null; recorder?: StepRecorder; browserWsEndpoint?: string | null;
    /** Other egresses the searches spread over once the host's own one has no turn. */
    egressPool?: readonly Egress[];
    /** SENGI Express's lookup, asked about a `5P` code Poste does not know yet. */
    sengi?: PosteItalianeSengiLookup } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Poste Italiane tracking timeout must be positive');
    }
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizePosteItalianeTrackingNumber(rawTrackingNumber);
    return runSteps({ carrier: 'poste-italiane', signal: context.signal, recorder: this.options.recorder,
      budgetMs: context.budgetMs ?? ((this.options.trawl || this.options.browserWsEndpoint) ? 45_000 : 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS) }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(trackingNumber, { signal, budgetMs: remainingMs }) },
      { id: 'trawl', enabled: !!this.options.trawl, recovers: error => error instanceof ChallengeError,
        run: ({ signal, remainingMs, previousError }) => {
          if (remainingMs < 8000) throw previousError;
          return this.browser(trackingNumber, signal, remainingMs);
        } },
      { id: 'browser', enabled: !!this.options.browserWsEndpoint, recovers: error => error instanceof ChallengeError,
        run: async ({ signal, remainingMs, previousError }) => {
          if (remainingMs < 4000) throw previousError;
          const payload = await fetchPosteItalianeInBrowser(trackingNumber, this.options.browserWsEndpoint!, signal,
            Math.min(15_000, remainingMs - 1000));
          return parsePosteItalianeTrackingResponse(payload, trackingNumber);
        } },
      { id: 'sengi',
        // A `5P` code Poste does not know yet can be on SENGI Express's line to Poste, whose
        // tracker holds the parcel from China until the hand-over. Only an answer on that
        // line stands for Poste's; any other leaves Poste's not found.
        enabled: !!this.options.sengi && SENGI_LINE_CODE.test(trackingNumber),
        recovers: error => error instanceof NotFoundError,
        run: async ({ signal, remainingMs, previousError }) => {
          const answer = await this.options.sengi!(trackingNumber, { signal, budgetMs: Math.min(SENGI_BUDGET_MS, remainingMs) }).catch(() => {
            context.signal?.throwIfAborted();
            return null;
          });
          if (answer?.delivery_carrier !== 'poste-italiane' || !answer.events?.length) throw previousError;
          const leg: CarrierResult = { ...answer };
          delete leg.delivery_carrier;
          delete leg.delivery_tracking_number;
          return leg;
        } },
    ]);
  }

  private async direct(trackingNumber: string, context: TrackingContext): Promise<CarrierResult> {
    // The default budget covers the request, the pause and the one transient retry.
    const budget = lookupBudget(context, 2 * this.timeoutMs + TRANSIENT_RETRY_DELAY_MS);
    const egresses = egressesOf(this.fetcher, this.options.egressPool);
    // An egress the firewall refused rests; the search goes once more through another one that has a turn.
    for (let attempt = 0; ; attempt++) {
      budget.signal.throwIfAborted();
      const egress = SEARCHES.take(egresses);
      const { response, bytes } = await this.search(trackingNumber, egress.fetcher, budget);
      budget.signal.throwIfAborted();
      if ([404, 410].includes(response.status)) {
        throw new TransportError('Poste Italiane', 'Poste Italiane tracking endpoint is unavailable', {
          cause: new UpstreamHttpError('Poste Italiane tracking', response.status),
        });
      }
      if (response.status === 429) {
        SEARCHES.refused(egress, retryAfterMs(response.headers.get('retry-after')));
        const others = egresses.filter(other => other !== egress);
        if (attempt === 0 && others.length && SEARCHES.waitMs(others) === 0 && budget.remainingMs() > this.timeoutMs) continue;
        throw new RateLimitedError('Poste Italiane', SEARCHES.waitMs(egresses));
      }
      if (response.status === 400 && captchaRequired(bytes)) {
        SEARCHES.refused(egress, CAPTCHA_PAUSE_MS);
        throw new ChallengeError('Poste Italiane', 'Poste Italiane asks for a CAPTCHA before more searches');
      }
      if (!response.ok) throw new UpstreamHttpError('Poste Italiane tracking', response.status);
      return parsePosteItalianeTrackingResponse(parseJsonBytes(bytes, 'Poste Italiane tracking'), trackingNumber);
    }
  }

  private search(trackingNumber: string, fetcher: typeof fetch | undefined, budget: ReturnType<typeof lookupBudget>) {
    return fetchBounded(APP_TRACKING_ENDPOINT, {
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
      body: JSON.stringify({ codiceSpedizione: trackingNumber, tipoRichiedente: 'APP', periodoRicerca: 1 }),
    }, {
      provider: 'Poste Italiane tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      deadline: budget.deadline,
      allowHttpError: true,
      fetcher,
    });
  }

  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const timeoutMs = Math.floor(remainingMs - 2000);
    const page = await this.options.trawl!.scrape({ url: posteItalianeTrackingUrl(number), skipHttp: true, maxTier: 3,
      captureResponses: [TRACKING_ENDPOINT], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
    { provider: 'Poste Italiane', timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 6 * MAX_RESPONSE_BYTES })
      .catch(budgetWhenOutOfTime('Poste Italiane', remainingMs));
    signal.throwIfAborted();
    const responses = page.capturedResponses.filter(row => row.url === TRACKING_ENDPOINT);
    const response = responses.at(-1);
    if (!response || responses.length > 10) throw new ChallengeError('Poste Italiane', 'Poste Italiane returned no matching browser response');
    if (response.status === 429) {
      // The browser goes out through the host's own address.
      const own = egressesOf(this.fetcher, undefined);
      SEARCHES.refused(own[0]!, retryAfterMs(response.headers['retry-after'] ?? response.headers['Retry-After']));
      throw new RateLimitedError('Poste Italiane', SEARCHES.waitMs(own));
    }
    const bytes = new TextEncoder().encode(response.body ?? '');
    if ([401, 403].includes(response.status) || (response.status === 400 && captchaRequired(bytes))) {
      throw new ChallengeError('Poste Italiane', 'Poste Italiane still requires verification');
    }
    if (response.status >= 400) throw new UpstreamHttpError('Poste Italiane', response.status);
    if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
      throw new TransportError('Poste Italiane', 'Poste Italiane returned an incomplete browser response');
    }
    if (bytes.length > MAX_RESPONSE_BYTES) throw new SchemaError('Poste Italiane', 'Poste Italiane returned excessive browser data');
    return parsePosteItalianeTrackingResponse(parseJsonBytes(bytes, 'Poste Italiane'), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const options = { fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder,
    egressPool: environment.egressPools?.datacenter };
  const endpoint = environment.env.POSTE_ITALIANE_BROWSER_WS_ENDPOINT?.trim() || null;
  const sengi = new SengiExpressTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  const tracker = new PosteItalianeTracker({ ...options, trawl: environment.trawl, browserWsEndpoint: endpoint,
    sengi: (number, context) => sengi.fetch(number, context) });
  // Cheap recognition never opens a browser or spends the shared audio allowance, and reads Poste alone.
  const recognition = new PosteItalianeTracker(options);
  return {
    id: 'poste-italiane',
    recordsSteps: true,
    steps: endpoint ? ['direct', 'trawl', 'browser', 'sengi'] : ['direct', 'trawl', 'sengi'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => recognition.fetch(number, context), () => accepted(() => normalizePosteItalianeTrackingNumber(number))),
  };
};
