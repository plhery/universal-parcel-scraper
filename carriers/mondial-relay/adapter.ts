
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { isValidMondialRelayBarcode } from '../../core/detection/index.js';
import { ChallengeError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isoTime, zonedTime, type ParsedTime } from '../../core/time/index.js';
import { cleanScalar, TRAWL_TRANSPORT_ALLOWANCE_MS, trawlBody, TrawlClient, type TrawlScrapeRequest, type TrawlScrapeResponse } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { MondialRelayAppClient } from './app.js';
import { classifyStatus, milestoneNumberStatus, scanSite } from './status.js';

// Protocol provenance (inspected 2026-08-30):
// https://www.mondialrelay.fr/versioned-assets/2nMAiuVI9Rv9J3kZacblPYCfCABwzS-qZ3m7eFBQn4A/Scripts/vue/tracking/js/app.js
// SHA-256: da73008ae548f51bfd27791969c6e53d809f080070cd2faa6779bb7850509f80
// The current official bundle reads the server-rendered `token` attribute from
// #tracking and sends it as RequestVerificationToken to GET /api/tracking.
// Mondial Relay's current CONNECT guide documents 8-, 10-, and 12-digit IDs:
// https://www.mondialrelay.fr/media/124728/fr-documentation-utilisateur-connect-v-12.pdf
const TRACKING_PAGE = 'https://www.mondialrelay.fr/suivi-de-colis/';
const TRACKING_API = 'https://www.mondialrelay.fr/api/tracking';
const MAX_DIRECT_BYTES = 2_000_000;
const MAX_TRAWL_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 90_000;
/** The app answers in about a second; past this the website gets the rest of the budget. */
const DEFAULT_DIRECT_TIMEOUT_MS = 10_000;
const ZONE = 'Europe/Paris';
const CREDENTIAL_MESSAGE = 'Mondial Relay tracking requires a 26-digit label barcode, a 10- or 12-digit shipment '
  + 'number, or an 8-digit shipment number with the recipient postcode';

interface MondialRelayCredential {
  shipment: string;
  /** The recipient's, as typed; empty when the number needs none. */
  postcode: string;
  canonicalShipment?: string;
  /** Read from a checksummed label barcode, which needs no postcode. */
  barcode?: true;
}

interface ParsedEvent {
  event: CarrierEvent;
  classified: ClassifiedStatus;
  timestamp: number;
  index: number;
}

/** Strip the markup Mondial Relay embeds in its labels, entities included. */
function plainText(value: unknown, limit = 500): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value).slice(0, Math.max(limit * 10, 5_000));
  return cleanScalar(load(raw).text(), limit);
}

function plausibleFrenchPostcode(value: string): boolean {
  return /^(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/.test(value);
}

/**
 * The shipment and the postcode Mondial Relay is asked with. The postcode is
 * compared with the recipient's as typed, in any country's format: the country
 * sent alongside only picks the reply's language. Only an 8-digit shipment
 * needs it; the 10- and 12-digit forms carry the brand and are found without
 * one, so a postcode typed for them is not sent.
 */
export function normalizeMondialRelayCredential(
  rawShipment: string,
  rawPostcode = '',
): MondialRelayCredential {
  let shipment = rawShipment.trim().replace(/[\s.-]/g, '');
  let postcode = deliveryPostcodeText(rawPostcode);
  if (/^\d{26}$/.test(shipment)) {
    if (!isValidMondialRelayBarcode(shipment) || (postcode && !DELIVERY_POSTCODE.test(postcode))) {
      throw new InvalidInputError('Mondial Relay', 'Invalid Mondial Relay barcode or postcode');
    }
    // The public alias carries brand/shipment/parcel sequence, not a postcode.
    return { shipment: shipment.slice(0, 12), postcode, canonicalShipment: shipment.slice(2, 10), barcode: true };
  }
  if (!postcode && /^(?:\d{13}|\d{15}|\d{17})$/.test(shipment)) {
    // A French label prints the shipment followed by the 5-digit postcode.
    if (!plausibleFrenchPostcode(shipment.slice(-5))) throw new InvalidInputError('Mondial Relay', CREDENTIAL_MESSAGE);
    postcode = shipment.slice(-5);
    shipment = shipment.slice(0, -5);
  }
  if (!/^(?:\d{8}|\d{10}|\d{12})$/.test(shipment)) throw new InvalidInputError('Mondial Relay', CREDENTIAL_MESSAGE);
  if (shipment.length === 8 && !DELIVERY_POSTCODE.test(postcode)) {
    // A well-shaped number without a usable postcode is a missing credential.
    throw new InputRequiredError('Mondial Relay', 'the recipient postcode', CREDENTIAL_MESSAGE);
  }
  // The longer forms put the 2-digit brand before the 8-digit shipment (the
  // 12-digit one adds the parcel sequence), and the API echoes the shipment.
  return shipment.length > 8
    ? { shipment, postcode: '', canonicalShipment: shipment.slice(2, 10) }
    : { shipment, postcode };
}

export function mondialRelayTrackingUrl(rawShipment: string, rawPostcode = ''): string {
  const credential = normalizeMondialRelayCredential(rawShipment, rawPostcode);
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('numeroExpedition', credential.shipment);
  return url.toString();
}

function trackingApiUrl(credential: MondialRelayCredential, brand = ''): string {
  const url = new URL(TRACKING_API);
  url.searchParams.set('shipment', credential.shipment);
  url.searchParams.set('postcode', credential.postcode);
  url.searchParams.set('brand', brand);
  // Only the reply's language: the postcode matches whatever country it is from.
  // The status and event parsers read French.
  url.searchParams.set('codePays', 'fr');
  return url.toString();
}

function verificationToken(html: string): string {
  const $ = load(html);
  const token = cleanScalar($('#tracking').first().attr('token'), 4_096);
  if (!/^[A-Za-z0-9:_-]{20,4096}$/.test(token)) {
    throw new ChallengeError('Mondial Relay', 'Mondial Relay did not issue a request token');
  }
  return token;
}

/**
 * An event timestamp. Mondial Relay sends offset-less Paris wall-clock time in
 * several shapes; a bare calendar day is kept as a day, because stamping
 * midnight on it would invent a precision the provider did not give.
 */
function eventTime(value: unknown): ParsedTime | null {
  const raw = cleanScalar(value, 64);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const day = isoTime(raw, ZONE);
    return day ? { iso: raw, timestamp: day.timestamp } : null;
  }
  return isoTime(raw, ZONE)
    ?? zonedTime(raw, 'dd/MM/yyyy HH:mm:ss', ZONE)
    ?? zonedTime(raw, 'dd/MM/yyyy HH:mm', ZONE)
    ?? zonedTime(raw, 'dd/MM/yyyy', ZONE);
}

/**
 * The delivery estimate, reduced to its calendar day. None of the core time
 * policies fits: they all return an instant, and the estimate is read in Paris
 * even when it carries an offset, as the provider sends it offset-less.
 */
function expectedDelivery(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  if (!raw || raw.startsWith('0001-01-01')) return null;
  const date = DateTime.fromISO(raw, { zone: ZONE });
  return date.isValid ? date.toISODate() : null;
}

function parseEvents(expedition: JsonObject): ParsedEvent[] {
  if (!Array.isArray(expedition.Evenements)) return [];
  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  expedition.Evenements.forEach((rawEvent, index) => {
    if (!isRecord(rawEvent)) return;
    const time = eventTime(rawEvent.Date);
    const description = plainText(rawEvent.Libelle);
    if (!time || !description) return;
    const identity = JSON.stringify([time.iso, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsed.push({
      event: {
        time: time.iso,
        location: scanSite(description),
        description,
        stage: classified.stage,
      },
      classified,
      timestamp: time.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  return parsed.slice(0, 100);
}

function milestoneStatus(expedition: JsonObject): ClassifiedStatus | null {
  if (!isRecord(expedition.SuiviParEtapes)) return null;
  const reached: Array<{ number: number; status: ClassifiedStatus }> = [];
  for (const raw of Object.values(expedition.SuiviParEtapes)) {
    if (!isRecord(raw) || !isRecord(raw.Evenement) || !cleanScalar(raw.Evenement.Date, 64)) continue;
    const number = Number(raw.Numero);
    const classified = classifyStatus(plainText(raw.Libelle));
    if (Number.isFinite(number)) reached.push({ number, status: classified });
  }
  reached.sort((left, right) => right.number - left.number);
  const latest = reached[0];
  if (!latest) return null;
  if (latest.status.status !== 'unknown') return latest.status;
  return milestoneNumberStatus(latest.number);
}

export function parseMondialRelayTrackingResponse(
  payload: unknown,
  rawShipment: string,
  rawPostcode = '',
): CarrierResult {
  return parseTrackingResponse(payload, normalizeMondialRelayCredential(rawShipment, rawPostcode));
}

function parseTrackingResponse(payload: unknown, credential: MondialRelayCredential): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError('Mondial Relay');
  if (!isRecord(payload.Expedition)) {
    const warning = Array.isArray(payload.status)
      && payload.status.some((entry) => isRecord(entry) && cleanScalar(entry.state, 32) === 'warn');
    // The provider echoes the query in that warning; only the fact is kept.
    if (warning || Array.isArray(payload.FiltresRecherche)) throw new NotFoundError('Mondial Relay');
    throw new SchemaError('Mondial Relay', 'Mondial Relay returned incomplete tracking details');
  }

  const expedition = payload.Expedition;
  const returnedShipment = cleanScalar(expedition.Numero, 32).replace(/\s/g, '');
  if (!/^(?:\d{8}|\d{10}|\d{12})$/.test(returnedShipment)) {
    throw new SchemaError('Mondial Relay', 'Mondial Relay returned an invalid shipment number');
  }
  if (returnedShipment !== credential.shipment && returnedShipment !== credential.canonicalShipment) {
    throw new SchemaError('Mondial Relay', 'Mondial Relay returned a different shipment');
  }

  const parsedEvents = parseEvents(expedition);
  const events = parsedEvents.map(({ event }) => event);
  const contextual = plainText(expedition.SuiviContextuel);
  const statusText = contextual || events[0]?.description || 'Tracking information received';
  const contextualStatus = classifyStatus(statusText);
  const current = contextualStatus.status !== 'unknown'
    ? contextualStatus
    : parsedEvents.find((event) => event.classified.status !== 'unknown')?.classified
      ?? milestoneStatus(expedition);
  const status = current?.status ?? 'unknown';

  return {
    status,
    // The status vocabulary has no pickup value; without the stage the sync
    // would re-read the headline and fall back to "out for delivery".
    ...(current ? { current_stage: current.stage } : {}),
    last_status_text: statusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: ['delivered', 'exception'].includes(status)
      ? null
      : expectedDelivery(expedition.EstimatedDeliveryDate),
    timezone: ZONE,
    events,
    source: 'mondial_relay_public_web',
  };
}

/**
 * The page the browser actually loaded. Mondial Relay's Vue app replaces the
 * `#tracking` root as soon as it boots, so the captured response body carries
 * the server-rendered token that the rendered HTML no longer has.
 */
function originalTrawlPage(response: TrawlScrapeResponse): string {
  const body = trawlBody(response.raw, MAX_DIRECT_BYTES);
  return body.includes('id="tracking"') || body.includes("id='tracking'") ? body : response.html;
}

function trawlJson(response: TrawlScrapeResponse): unknown {
  const candidates = [trawlBody(response.raw, MAX_DIRECT_BYTES)];
  const $ = load(response.html);
  candidates.push($('pre').first().text(), $('body').text(), response.html);
  for (const candidate of candidates) {
    const cleaned = candidate.trim().replace(/^\uFEFF/, '');
    if (!cleaned) continue;
    try {
      return JSON.parse(cleaned);
    } catch {
      // Try the next representation. Browser navigations wrap JSON in a <pre>.
    }
  }
  throw new SchemaError('Mondial Relay', 'Mondial Relay browser fallback returned invalid tracking data');
}

function assertTrawlTarget(response: TrawlScrapeResponse, expectedUrl: string): void {
  const returned = cleanScalar(response.url, 2_048);
  if (!returned) return;
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(returned);
    expected = new URL(expectedUrl);
  } catch (error) {
    throw new SchemaError('Mondial Relay', 'Mondial Relay browser fallback returned an invalid URL', { cause: error });
  }
  if (actual.origin !== expected.origin
    || actual.pathname !== expected.pathname
    || actual.searchParams.get('shipment') !== expected.searchParams.get('shipment')
    || actual.searchParams.get('postcode') !== expected.searchParams.get('postcode')) {
    throw new SchemaError('Mondial Relay', 'Mondial Relay browser fallback returned a different shipment');
  }
}

export interface MondialRelayTrackerOptions {
  timeoutMs?: number;
  /** How long the app step may take before the website is tried. */
  directTimeoutMs?: number;
  /** Legacy configuration seam; `trawl` is preferred. */
  trawlUrl?: string;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  /** An InPost account's refresh token for the app step; without one the website answers alone. */
  appRefreshToken?: string;
  /** Test seam for the app step; built from `appRefreshToken` when absent. */
  app?: MondialRelayAppClient | null;
  fetcher?: typeof fetch;
  userAgent?: string;
  recorder?: StepRecorder;
}

export class MondialRelayTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly trawlUrl: string;
  readonly #trawl: TrawlClient | null | undefined;
  readonly #app: MondialRelayAppClient | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;
  readonly #serialize = singleFlight();

  constructor(options: MondialRelayTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
    ));
    this.trawlUrl = (options.trawlUrl ?? '').trim();
    this.#trawl = options.trawl;
    this.#app = options.app !== undefined ? options.app : options.appRefreshToken?.trim()
      ? new MondialRelayAppClient({ refreshToken: options.appRefreshToken, fetcher: options.fetcher, userAgent: options.userAgent })
      : null;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Mondial Relay timeout must be positive');
    }
  }

  /** The injected browser service, or one built from the configured URL. */
  #browserService(): TrawlClient | null {
    if (this.#trawl !== undefined) return this.#trawl;
    return this.trawlUrl ? new TrawlClient(this.trawlUrl, this.#fetcher) : null;
  }

  async fetch(rawShipment: string, rawPostcode = '', context: TrackingContext = {}): Promise<CarrierResult> {
    // One lookup at a time: the page token and the API call have to stay on the
    // same solved browser identity, and the app's access token is renewed once.
    return takeTurn(this.#serialize, 'Mondial Relay', context,
      (left) => this.#lookup(normalizeMondialRelayCredential(rawShipment, rawPostcode), left));
  }

  async #lookup(credential: MondialRelayCredential, context: TrackingContext): Promise<CarrierResult> {
    // Cloudflare blocks every non-browser client of the website with an HTTP
    // 403 WAF block (verified from multiple networks, 2026-09-10). The app's
    // backend answers plain HTTP, but only for a signed-in account.
    const app = this.#app;
    const trawl = this.#browserService();
    if (!app && !trawl) {
      throw new ChallengeError(
        'Mondial Relay',
        'Mondial Relay challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    return runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'mondial-relay', budgetMs: context.budgetMs ?? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS, signal: context.signal,
      recorder: this.#recorder,
    }, [
      {
        id: 'app',
        enabled: app !== null,
        run: async ({ remainingMs, signal }) => {
          // The app filters on the recipient postcode only; a label barcode is its own proof.
          const query = { shipment: credential.shipment, postcode: credential.barcode ? '' : credential.postcode };
          const result = await app!.track(query, { signal, timeoutMs: Math.min(remainingMs, this.directTimeoutMs) });
          return this.#link(result, credential, 'mobile-app-response');
        },
      },
      {
        id: 'trawl',
        enabled: trawl !== null,
        // The website is a separate service: no failure of the app settles the lookup.
        recovers: () => true,
        run: ({ remainingMs, signal }) => this.#trawlResult(trawl!, credential, performance.now() + remainingMs, signal),
      },
    ]);
  }

  async #trawlResult(
    trawl: TrawlClient,
    credential: MondialRelayCredential,
    deadline: number,
    signal: AbortSignal,
  ): Promise<CarrierResult> {
    const bootstrap = await this.#scrape(trawl, { url: TRACKING_PAGE }, deadline, signal);
    const token = verificationToken(originalTrawlPage(bootstrap));
    const apiUrl = trackingApiUrl(credential);
    const tracked = await this.#scrape(trawl, {
      url: apiUrl,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: token,
      },
    }, deadline, signal);
    assertTrawlTarget(tracked, apiUrl);
    return this.#finish(trawlJson(tracked), credential, 'browser-session-response');
  }

  /** One browser request, given what is left of the lookup budget up to the tracker's own timeout. */
  #scrape(
    trawl: TrawlClient,
    request: TrawlScrapeRequest,
    deadline: number,
    signal: AbortSignal,
  ): Promise<TrawlScrapeResponse> {
    const timeoutMs = Math.max(1, Math.floor(Math.min(this.timeoutMs, deadline - performance.now())));
    return trawl.scrape({ skipHttp: true, maxTier: 3, maxTimeout: timeoutMs, ...request }, {
      provider: 'TRAWL while fetching Mondial Relay',
      timeoutMs,
      maxBytes: MAX_TRAWL_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
  }

  #finish(
    payload: unknown,
    credential: MondialRelayCredential,
    trackingSource: string,
  ): CarrierResult {
    return this.#link(parseTrackingResponse(payload, credential), credential, trackingSource);
  }

  #link(result: CarrierResult, credential: MondialRelayCredential, trackingSource: string): CarrierResult {
    const url = new URL(TRACKING_PAGE);
    url.searchParams.set('numeroExpedition', credential.shipment);
    result.tracking_url = url.toString();
    result.tracking_source = trackingSource;
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MondialRelayTracker({
    fetcher: environment.fetcher,
    userAgent: environment.userAgent,
    trawl: environment.trawl,
    appRefreshToken: environment.env.MONDIAL_RELAY_REFRESH_TOKEN,
    recorder: environment.recorder,
  });
  return {
    id: 'mondial-relay', recordsSteps: true,
    // Cloudflare refuses every non-browser client of the website; the app step needs an account.
    steps: ['app', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
  };
};
