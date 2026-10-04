/**
 * Colis Privé: the public "Mon Colis" detail page.
 *
 * One bounded GET per lookup ('direct' step). The page is server-rendered HTML
 * that contains the status banner, the timeline table and — in a `.divDesti`
 * block — the recipient's name and full delivery address. That block is removed
 * before any text is read, so nothing identifying a person can reach the result.
 *
 * The lookup credential is the 12-character shipment number followed by the
 * recipient's 5-digit postcode. The postcode is what makes the page reachable,
 * so it is part of the tracking credential: it is never logged, put in an issue
 * or written into a fixture.
 */

import { load } from 'cheerio';
import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { UpstreamHttpError, clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { classifyStatus } from './status.js';

export { classifyStatus } from './status.js';

const PROVIDER = 'Colis Privé';
const TRACKING_ENDPOINT = 'https://colisprive.com/moncolis/pages/DetailColis.aspx';
const TIMEZONE = 'Europe/Paris';
const MAX_RESPONSE_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS_TO_RETURN = 100;

function shipmentPart(credential: string): string {
  return credential.slice(0, 12);
}

function displayedShipmentNumber(value: string): string {
  return value.replace(/\s/g, '').toLocaleUpperCase('en-US');
}

/**
 * The timeline prints `DD/MM/YYYY` and no clock, so there is no instant to
 * parse: `core/time` deliberately has no day-only policy. The raw string stays
 * the event time and this helper only produces a sort key, rejecting
 * impossible dates such as 31/02.
 */
function dateKey(value: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return timestamp;
}

/**
 * Kept as a named class because the host's sync tests and the grouped live
 * suite construct it and match on its name. It is a plain `NotFoundError`.
 */
export class ColisPriveTrackingError extends NotFoundError {
  constructor() {
    super(PROVIDER);
    this.name = 'ColisPriveTrackingError';
  }
}

export function normalizeColisPriveCredential(raw: string): string {
  const credential = raw.trim().toLocaleUpperCase('en-US');
  if (!/^[A-Z0-9]{12}(?:0[1-9]|[1-8]\d|9[0-5]|97|98)\d{3}$/.test(credential)) {
    throw new InvalidInputError(PROVIDER, 'Colis Privé tracking requires the 12-character shipment number followed by the 5-digit recipient postcode');
  }
  return credential;
}

export function colisPriveTrackingUrl(rawCredential: string): string {
  const credential = normalizeColisPriveCredential(rawCredential);
  const url = new URL(TRACKING_ENDPOINT);
  url.searchParams.set('numColis', credential);
  url.searchParams.set('lang', 'fr');
  return url.toString();
}

export function parseColisPriveTrackingHtml(
  html: string,
  rawCredential: string,
): CarrierResult {
  const credential = normalizeColisPriveCredential(rawCredential);
  if (!html.trim()) throw new SchemaError(PROVIDER, 'Colis Privé returned an empty tracking response');

  const $ = load(html);
  // This section contains the recipient's name and full delivery address. Remove it
  // before reading any text from the response and never include it in adapter output.
  $('.divDesti').remove();

  const banner = $('.BandeauInfoColis').first();
  if (banner.length === 0) {
    throw new SchemaError(PROVIDER, 'Colis Privé did not return tracking details');
  }

  const responseNumber = displayedShipmentNumber(banner.find('.divColis .tdText').first().text());
  if (!/^[A-Z0-9]{12}$/.test(responseNumber)) {
    throw new SchemaError(PROVIDER, 'Colis Privé returned an invalid shipment number');
  }
  if (responseNumber !== shipmentPart(credential)) {
    throw new SchemaError(PROVIDER, 'Colis Privé returned a different shipment');
  }

  const statusText = clean(banner.find('.divStatut .tdText').first().text());
  if (!statusText) throw new SchemaError(PROVIDER, 'Colis Privé did not return a shipment status');

  const parsedEvents: Array<{
    event: CarrierEvent;
    status: CarrierStatus;
    timestamp: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  $('.tableHistoriqueColis tr.bandeauText').each((index, element) => {
    const row = $(element);
    const time = clean(row.children('td[headers="th-date"]').first().text(), 32);
    const description = clean(row.children('td[headers="th-statut"]').first().text());
    const timestamp = dateKey(time);
    if (timestamp === null || !description) return;
    const identity = `${time}\0${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsedEvents.push({
      event: {
        time,
        location: '',
        description,
        // Unmapped wording carries no stage: the sync classifies and records it.
        ...(classified.stage ? { stage: classified.stage } : {}),
      },
      status: classified.status,
      timestamp,
      index,
    });
  });
  parsedEvents.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsedEvents.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);

  const current = classifyStatus(statusText);
  const status = current.status !== 'unknown'
    ? current.status
    : parsedEvents.find((event) => event.status !== 'unknown')?.status ?? 'unknown';
  return {
    status,
    last_status_text: statusText,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    timezone: TIMEZONE,
    events,
  };
}

export interface ColisPriveTrackerOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class ColisPriveTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: ColisPriveTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('Colis Privé timeout must be positive');
    }
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
  }

  async fetch(rawCredential: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const credential = normalizeColisPriveCredential(rawCredential);
    const budget = lookupBudget(context, this.timeoutMs);
    const { response, bytes } = await fetchBounded(colisPriveTrackingUrl(credential), {
      signal: budget.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: 'Colis Privé tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      allowHttpError: true,
      fetcher: this.#fetcher,
    });

    // An unknown shipment is bounced to the search page instead of answering 404.
    if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
      throw new ColisPriveTrackingError();
    }
    if (!response.ok) {
      throw new UpstreamHttpError('Colis Privé tracking', response.status);
    }
    return parseColisPriveTrackingHtml(decodeText(bytes), credential);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ColisPriveTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'colis-prive',
    steps: ['direct'],
    // The postcode is already part of the stored number for this carrier.
    track: (input, context) => tracker.fetch(input.number, context),
    // A bare 12-character number needs the postcode appended: it reads as unknown.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeColisPriveCredential(number))),
  };
};
