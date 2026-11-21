/**
 * Colis Privé: the public "Mon Colis" detail page.
 *
 * One bounded GET per lookup ('direct' step). The page is server-rendered HTML
 * that contains the status banner, the timeline table and — in a `.divDesti`
 * block — the recipient's name and full delivery address. That block becomes the
 * result's recipient and is then removed, so no other selector reads it.
 *
 * The lookup credential is the 12-character shipment number followed by the
 * recipient's postcode: five digits in France, four in Belgium, bare or after
 * B, or L and four digits in Luxembourg. The postcode comes at the end of the
 * number, as in Colis Privé's own links, or as a separate input. It is what
 * makes the page reachable, so it is part of the tracking credential: it is
 * never logged, put in an issue or written into a fixture.
 */

import { load } from 'cheerio';
import { lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { colisPrivePostcode } from '../../core/catalog/postcode.js';
import { InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { UpstreamHttpError, clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { paddedDate } from '../../core/time/fields.js';
import { calendarDay } from '../../core/time/index.js';
import { classifyStatus, comparableText } from './status.js';

export { classifyStatus } from './status.js';

const PROVIDER = 'Colis Privé';
const TRACKING_ENDPOINT = 'https://www.colisprive.com/moncolis/pages/DetailColis.aspx';
const TIMEZONE = 'Europe/Paris';
const MAX_RESPONSE_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS_TO_RETURN = 100;
const CREDENTIAL_MESSAGE = 'Colis Privé tracking requires the 12-character shipment number and the recipient postcode '
  + '(5 digits in France, 4 in Belgium, or L and 4 digits in Luxembourg)';
const SHIPMENT = /^[A-Z0-9]{12}$/;

/** The shipment with its postcode at the end, as Colis Privé's links carry it. */
function combined(number: string): boolean {
  const postcode = number.slice(12);
  return SHIPMENT.test(number.slice(0, 12)) && colisPrivePostcode(postcode) === postcode;
}

function shipmentPart(credential: string): string {
  return credential.slice(0, 12);
}

function displayedShipmentNumber(value: string): string {
  return value.replace(/\s/g, '').toLocaleUpperCase('en-US');
}

/**
 * The timeline prints `DD/MM/YYYY` and no clock, so a scan keeps its day alone
 * in `local_time`. This helper gives the day's sort key, rejecting impossible
 * dates such as 31/02.
 */
function dateKey(value: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(paddedDate(value));
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

/**
 * The value the page is opened with: the shipment and the postcode, written
 * after it or given apart. A bare shipment is a missing credential, as the
 * page never opens without its postcode.
 */
export function normalizeColisPriveCredential(raw: string, rawPostcode = ''): string {
  const number = raw.trim().toLocaleUpperCase('en-US');
  if (rawPostcode.trim()) {
    const postcode = colisPrivePostcode(rawPostcode);
    if (!SHIPMENT.test(number) || !postcode) throw new InvalidInputError(PROVIDER, CREDENTIAL_MESSAGE);
    return `${number}${postcode}`;
  }
  if (SHIPMENT.test(number)) throw new InputRequiredError(PROVIDER, 'the recipient postcode', CREDENTIAL_MESSAGE);
  if (!combined(number)) throw new InvalidInputError(PROVIDER, CREDENTIAL_MESSAGE);
  return number;
}

/** The day a row announces for a confirmed appointment or a relay drop-off: "… le DD/MM/YYYY". */
function plannedDay(description: string): string | null {
  if (!/\b(?:rendez vous est confirme|va etre prochainement depose)\b/.test(comparableText(description))) return null;
  const match = /\ble (\d{2})\/(\d{2})\/(\d{4})\.?$/.exec(paddedDate(description));
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

const SETTLED: ReadonlySet<string> = new Set(['delivered', 'returned', 'exception', 'failed_attempt', 'ready_for_pickup']);

/** The same page on another Colis Privé host that a redirect names, as the bare domain sends every request to www. */
function movedHost(response: Response, requested: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  const from = new URL(requested);
  let to: URL;
  try {
    to = new URL(location, from);
  } catch {
    return null;
  }
  const ours = /(?:^|\.)colisprive\.com$/.test(to.hostname) && to.protocol === 'https:';
  return ours && to.hostname !== from.hostname && to.pathname === from.pathname && to.search === from.search ? to.toString() : null;
}

export function colisPriveTrackingUrl(rawCredential: string, rawPostcode = ''): string {
  const credential = normalizeColisPriveCredential(rawCredential, rawPostcode);
  const url = new URL(TRACKING_ENDPOINT);
  url.searchParams.set('numColis', credential);
  url.searchParams.set('lang', 'fr');
  return url.toString();
}

// A line that opens with a French, Belgian or Luxembourg postcode, as an address's town line does.
const TOWN_LINE = /^(?:\d{5}|[BL]?-?\d{4})\s/i;

/**
 * The recipient block's lines: the name, then the street and the postcode and town. A block of
 * one line is the name, or the town line alone; the address keeps its street lines on one.
 */
function recipientOf(block: string): Pick<CarrierResult, 'receiver_name' | 'receiver_address'> {
  const lines = block.split('\n').map((line) => clean(line, 200)).filter(Boolean).slice(0, 6);
  if (!lines.length) return {};
  const named = lines.length > 1 || !TOWN_LINE.test(lines[0]!);
  const address = named ? lines.slice(1) : lines;
  const town = address.length > 1 && TOWN_LINE.test(address.at(-1)!) ? address.pop()! : '';
  const written = [address.join(', '), town].filter(Boolean).join('\n');
  return { ...(named ? { receiver_name: lines[0]! } : {}), ...(written ? { receiver_address: written } : {}) };
}

export function parseColisPriveTrackingHtml(
  html: string,
  rawCredential: string,
): CarrierResult {
  const credential = normalizeColisPriveCredential(rawCredential);
  if (!html.trim()) throw new SchemaError(PROVIDER, 'Colis Privé returned an empty tracking response');

  const $ = load(html);
  // This section holds the recipient's name, then their address, one line each. It is
  // read on its own and removed, so no other selector takes its text for a status.
  const block = $('.divDesti .tdText').first();
  block.find('br').replaceWith('\n');
  const recipient = recipientOf(block.text());
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
    const description = clean(row.children('td[headers="th-statut"]').first().text());
    const timestamp = dateKey(clean(row.children('td[headers="th-date"]').first().text(), 32));
    if (timestamp === null || !description) return;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const identity = `${day}\0${description}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyStatus(description);
    parsedEvents.push({
      event: {
        local_time: day,
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

  // The banner can lag the timeline: one that repeats an older row's wording
  // while the newest row says something else gives way to that row.
  const [newest, ...older] = parsedEvents;
  const shown = comparableText(statusText);
  const lagging = newest?.event.stage && comparableText(newest.event.description ?? '') !== shown
    && older.some(({ event }) => comparableText(event.description ?? '') === shown);
  const summary = lagging ? newest.event.description! : statusText;
  const current = classifyStatus(summary);
  const status = current.status !== 'unknown'
    ? current.status
    : parsedEvents.find((event) => event.status !== 'unknown')?.status ?? 'unknown';
  // The newest announced day, unless the parcel has settled or the latest row is already past it.
  const stage = current.stage ?? parsedEvents.find(({ event }) => event.stage)?.event.stage;
  const planned = parsedEvents.map(({ event }) => plannedDay(event.description ?? '')).find(Boolean) ?? null;
  const latestDay = parsedEvents[0]?.timestamp;
  const expected = planned && !(stage && SETTLED.has(stage)) && latestDay !== undefined
    && Date.parse(`${planned}T00:00:00Z`) >= latestDay ? planned : null;
  return {
    status,
    // The banner's stage, as the map reads it, so the sync does not read the banner again by the shared rules.
    ...(current.stage ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: summary,
    last_update: null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: expected,
    ...recipient,
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

  async fetch(rawCredential: string, rawPostcode = '', context: TrackingContext = {}): Promise<CarrierResult> {
    const credential = normalizeColisPriveCredential(rawCredential, rawPostcode);
    const budget = lookupBudget(context, this.timeoutMs);
    const request = (url: string) => fetchBounded(url, {
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
    const url = colisPriveTrackingUrl(credential);
    let { response, bytes } = await request(url);
    // The site moving to another of its hosts keeps the page and its query: that move is followed once.
    const moved = movedHost(response, url);
    if (moved) ({ response, bytes } = await request(moved));

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
    // The postcode ends the number, or a bare number carries it apart.
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
    // Recognition gets no postcode, so a bare 12-character number reads as unknown.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, '', context),
      () => combined(number.trim().toLocaleUpperCase('en-US'))),
  };
};
