import { load } from 'cheerio';
import { lookupBudget, readerLanguage, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import type { Stage } from '../../generated/catalog.js';
import { countryCode, countryTimeZone, isoTime } from '../../core/time/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  FALLBACK_EVENT_LABELS, GLOBAL_STATUS_STAGE, STAGE_STATUS, STATUS_MAP, SWISS_POST_LANGUAGES, swissPostEventStage, swissPostRevoked,
  type SwissPostLanguage,
} from './status.js';
import { DESTINATION_EVENTS, PRE_ADVICE, PRE_ADVICE_ZONE, swissPostOriginZone } from './clock.js';

// «My consignments», Swiss Post's public tracker, asks this API without a session: a search by
// number gives each matching item's key, and the key gives the item with its scans.
const API_BASE = 'https://mys.post.ch/mailpiece-tracking-api/logistics/mailpiece/tracking/v2/mailpieces/compact/';
const searchUrl = (number: string) =>
  `${API_BASE}?${new URLSearchParams({ mailpieceId: number, includeAvailableServices: 'false' })}`;
const detailUrl = (key: string) => `${API_BASE}${encodeURIComponent(key)}/detail`;
const PROVIDER = 'Swiss Post';
const REQUEST_TIMEOUT_MS = 10_000;
/** Scans read from one reply, and the newest of them returned once they are sorted. */
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
/** The search and the item, each sent at most twice at its own bound. */
const DEFAULT_BUDGET_MS = 4 * REQUEST_TIMEOUT_MS;
/** A request's own timer can fire a few milliseconds before the budget's clock runs out. */
const BUDGET_SLACK_MS = 5;
const headers = (language: SwissPostLanguage) => ({
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': language,
  Referer: 'https://mys.post.ch/my-consignments/',
});

/** The refresh on Swiss Post's outage page: to `sorry.post.ch`, its own page for an unplanned outage. */
const OUTAGE_REFRESH = /^\s*\d+(?:\.\d*)?\s*[;,]\s*(?:url\s*=\s*)?(["']?)https?:\/\/sorry\.post\.ch\/?\1\s*$/i;

const REDIRECTS = [301, 302, 303, 307, 308];
/** The tracker answers an unknown number with an empty list, so a missing page means the API moved. */
const GONE = [404, 410];
/** Swiss Post's page for planned maintenance, in any of its languages, where its services redirect while closed. */
const MAINTENANCE_PAGE = /^https:\/\/www\.post\.ch\/[a-z]{2}\/pages\/maintenance\/?(?:[?#].*)?$/i;

/**
 * One call to the API. It redirects only when Swiss Post sends its visitors elsewhere: to its
 * maintenance page, which says the service is closed, or anywhere else, which is no tracking answer.
 * A missing page is no answer either: not a missing parcel.
 */
async function swissPostReply(url: string, init: RequestInit, signal: AbortSignal | null | undefined, timeoutMs: number, fetcher: typeof fetch) {
  const reply = await fetchBounded(url, { ...init, signal }, {
    provider: 'Swiss Post tracking', timeoutMs, fetcher, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE],
  });
  if (GONE.includes(reply.response.status)) throw new TransportError(PROVIDER, 'Swiss Post no longer serves this tracking call');
  if (!REDIRECTS.includes(reply.response.status)) return reply;
  let target = '';
  try { target = new URL(reply.response.headers.get('location') ?? '', url).href; } catch { /* no address */ }
  if (MAINTENANCE_PAGE.test(target)) throw new MaintenanceError(PROVIDER, 'Swiss Post tracking is closed for maintenance');
  throw new TransportError(PROVIDER, 'Swiss Post redirected its tracking service');
}

/**
 * A reply's JSON. While the service is down, a call can answer, even with HTTP 200, with Swiss
 * Post's outage page, which only refreshes to `sorry.post.ch`. That says nothing about the
 * shipment, so it is inconclusive; any other reply that does not parse stays malformed.
 */
function swissPostJson(bytes: Uint8Array): unknown {
  try {
    return parseJsonBytes(bytes, PROVIDER);
  } catch (cause) {
    const $ = load(decodeText(bytes));
    const outage = $('meta').filter((_, meta) => /^\s*refresh\s*$/i.test($(meta).attr('http-equiv') ?? '')
      && OUTAGE_REFRESH.test($(meta).attr('content') ?? '')).length > 0;
    if (outage) throw new IndeterminateError(PROVIDER, 'Swiss Post returned its outage page instead of tracking data', { cause });
    throw cause;
  }
}

export interface SwissPostOptions {
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
}

/**
 * Trim and cap without collapsing inner whitespace: Swiss Post's wording is
 * shown as the carrier writes it, so `core/transport`'s `clean` is
 * deliberately not used here.
 */
function text(value: unknown, limit = 500): string {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? String(value).trim().slice(0, limit) : '';
}

const record = (value: unknown): JsonObject => (isRecord(value) ? value : {});

/** Whether the lookup was cancelled or has spent its budget, rather than a request failing on its own. */
function ended(budget: LookupBudget): boolean {
  return budget.signal.aborted || budget.remainingMs() <= BUDGET_SLACK_MS;
}

function comparableShipmentNumber(value: unknown): string {
  return text(value, 64).replace(/[\s.-]/g, '').toUpperCase();
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:?\d{2})?$/i;

/** A timestamp as sent, with the seconds the tracker leaves out when they are zero written back. */
function withSeconds(value: string): string {
  return value.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?=Z|[+-]\d{2}:?\d{2}$|$)/i, '$1:00');
}

/** A bound's day and wall clock, as the tracker's page reads them from the offset it is sent with. */
function boundParts(value: unknown): { day: string; clock: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text(value, 40));
  return match ? { day: match[1]!, clock: match[2]! } : null;
}

/**
 * When the parcel is expected, as the tracker's page shows `status.expectedDelivery`: its day
 * with the time slot when the bounds name one, or the days of a window that spans several, as
 * the page writes "Wed 04.11. – Fri 06.11.". A bound at midnight opens or closes the day, not a slot.
 */
export function swissPostExpectedDelivery(status: JsonObject): { from: string | null; to: string } | null {
  const window = record(status.expectedDelivery);
  const from = boundParts(window.from);
  const to = boundParts(window.to);
  if (from && to && from.day !== to.day) return from.day < to.day ? { from: from.day, to: to.day } : { from: null, to: from.day };
  const day = (from ?? to)?.day;
  if (!day) return null;
  const clocks = [from && from.clock !== '00:00' ? from.clock : null, to && to.clock !== '23:59' ? to.clock : null]
    .filter((clock): clock is string => clock !== null);
  if (clocks.length === 0) return { from: null, to: day };
  if (clocks.length === 1 || clocks[0] === clocks[1]) return { from: null, to: `${day} ${clocks[0]}` };
  return { from: null, to: `${day} ${clocks[0]}–${clocks[1]}` };
}

/** A positive whole measurement, or null. Swiss Post sends 0 for an unmeasured item. */
function measurement(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(text(value, 20));
  return Number.isFinite(number) && number > 0 ? number : null;
}

const measured = (item: JsonObject) => record(record(item.physicalDimensions).details);

/** The item's weight: Swiss Post sends grams. */
function weightKg(item: JsonObject): number | null {
  const grams = measurement(measured(item).weight);
  return grams === null ? null : Math.round(grams) / 1000;
}

/** Length, width and height when measured: Swiss Post sends millimetres; letters often have two. */
function dimensionsText(item: JsonObject): string | null {
  const details = measured(item);
  const centimetres = ['length', 'width', 'height']
    .map((key) => measurement(details[key]))
    .filter((millimetres): millimetres is number => millimetres !== null)
    .map((millimetres) => Math.round(millimetres) / 10);
  return centimetres.length >= 2 ? `${centimetres.join(' × ')} cm` : null;
}

/** Plain text of a wording, in case it carries markup. */
function plain(value: string): string {
  return load(value, {}, false).root().text().trim().slice(0, 500);
}

/**
 * The scan's wording in the reader's language, then the detail the tracker shows under it, as
 * "Delivered — Deposited with authorization for delivery". Without wording, the built-in label.
 */
function eventDescription(event: JsonObject, code: string): string {
  const title = plain(text(event.title));
  const detail = plain(text(record(event.additionalInformation).information));
  const description = title && detail && detail !== title ? `${title} — ${detail}` : title || detail;
  return description || FALLBACK_EVENT_LABELS[code] || code || 'Tracking update';
}

/**
 * Operational scan location: the facility's name and postcode, or an explicit country when the
 * name is absent. A postcode alone places nothing.
 */
function eventLocation(event: JsonObject): string {
  const place = record(event.location);
  const city = text(place.city, 100);
  const postcode = text(place.zipCode, 30);
  const country = countryCode(place.country);
  if (!city) return country && country !== 'ZZ' ? country : '';
  return [city, postcode].filter(Boolean).join(' ').slice(0, 160);
}

/**
 * The code as the former tracker wrote it, and as stored scans carry it: the item's type, a
 * star, its product and the scan's own code, as `PARCEL.*.2.1202`. The bare code stands alone
 * when the item has no type or product.
 */
function providerCode(item: JsonObject, code: string): string {
  const type = text(item.type, 20);
  const product = text(record(item.product).code, 20);
  return /^[A-Z_]+$/.test(type) && /^\w+$/.test(product) ? `${type}.*.${product}.${code}` : code;
}

/**
 * Local ordering policy: event timestamps are read only to sort. Values without
 * an offset are treated as UTC for that comparison, which keeps the ordering
 * stable without rewriting the string the carrier sent — the event keeps the
 * carrier's own `timestamp`, but for the clocks [clock.ts](clock.ts) lists.
 */
function timestamp(value: string): number {
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = Date.parse(explicitZone ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * A destination post's event, on its country's clock when that keeps one. In a
 * country with several, it keeps Swiss Post's offset, the last guess: hours
 * off, but the reply keeps its instants.
 */
function destinationClock(event: JsonObject, code: string, time: string, destination: string | null): string {
  const place = record(event.location);
  const located = text(place.city, 100) || text(place.zipCode, 30) || text(place.country, 10);
  const wall = WALL_CLOCK.exec(time)?.[1];
  if (!destination || located || !wall || !DESTINATION_EVENTS.has(code)) return time;
  const zone = countryTimeZone(destination);
  return (zone ? isoTime(wall, zone)?.iso : null) ?? time;
}

/** An origin office's event on a parcel from abroad, on that office's clock when [clock.ts](clock.ts) lists it. */
function originClock(event: JsonObject, time: string, imported: boolean): string {
  const zone = imported ? swissPostOriginZone(text(record(event.location).city, 100)) : null;
  const wall = WALL_CLOCK.exec(time)?.[1];
  return (zone && wall ? isoTime(wall, zone)?.iso : null) ?? time;
}

/** A consolidator's notice that its letter will shortly be handed over, on its system's clock ([clock.ts](clock.ts)). */
function preAdviceClock(code: string, time: string): string {
  const wall = WALL_CLOCK.exec(time)?.[1];
  if (!wall || code !== PRE_ADVICE) return time;
  return isoTime(wall, PRE_ADVICE_ZONE)?.iso ?? time;
}

/**
 * Ready at a PickPost or My Post 24 point, or a pickup notice left on the round,
 * and the point's own arrival scans.
 */
const PICKUP_READY = new Set(['2101', '2102', '910', '2100']);
const PICKUP_ARRIVAL = new Set(['1001', '1100']);
const LEFT_THE_POINT = new Set<string>(['out_for_delivery', 'delivered', 'failed_attempt', 'returned']);

/**
 * A parcel still waiting at its pickup point when the point scans its arrival
 * after the ready-for-pickup scan: a newest-first history whose newest scan is
 * that arrival, with a ready scan before it and nothing in between that takes
 * the parcel out again.
 */
function heldForPickup(events: readonly CarrierEvent[]): boolean {
  const codeOf = (event: CarrierEvent) => event.provider_code?.split('.').at(-1) ?? '';
  if (!events[0] || !PICKUP_ARRIVAL.has(codeOf(events[0]))) return false;
  const ready = events.findIndex((event) => PICKUP_READY.has(codeOf(event)) && event.stage === 'ready_for_pickup');
  return ready > 0 && events.slice(0, ready).every((event) => !LEFT_THE_POINT.has(event.stage ?? ''));
}

/** An address's lines as the tracker shows them, or empty. */
function addressLines(value: unknown): string {
  const lines = record(value).address;
  return Array.isArray(lines) ? lines.map((line) => text(line, 200)).filter((line) => /[\p{L}\d]/u.test(line)).join('\n') : '';
}

/** Liechtenstein's postcodes, which Swiss Post serves as its own. */
const LIECHTENSTEIN = /^94(?:8[5-9]|9[0-8])$/;

/**
 * Where a posted item goes: abroad, the country of the destination post whose tracker Swiss Post
 * links (`exportTrackingUrl`), by its country domain or as USPS; at home, Switzerland or
 * Liechtenstein by the delivery address's postcode. The reply names no country.
 */
function destinationCountry(item: JsonObject): string | null {
  if (text(item.international, 20) === 'EXPORT') {
    let host = '';
    try { host = new URL(text(item.exportTrackingUrl, 500)).hostname.toLowerCase(); } catch { /* no link */ }
    if (/(?:^|\.)usps\.com$/.test(host)) return 'US';
    const domain = /\.([a-z]{2})$/.exec(host)?.[1];
    // The United Kingdom's domain is not its country code.
    const country = domain === 'uk' ? 'GB' : countryCode(domain);
    return country && country !== 'CH' && country !== 'ZZ' ? country : null;
  }
  const postcode = text(record(record(item.recipientAddress).details).zipCode, 10);
  if (!/^\d{4}$/.test(postcode)) return null;
  return LIECHTENSTEIN.test(postcode) ? 'LI' : 'CH';
}

/** The badge Swiss Post puts on an item sent back to its sender, in each of the tracker's languages. */
const RETURN_BADGES = new Set(['return item', 'rücksendung', 'renvoi', 'rinvio']);

/** Whether the item is on its way back, or back, to its sender. */
function sentBack(item: JsonObject, globalStatus: string): boolean {
  const badges = Array.isArray(item.badges) ? item.badges : [];
  return globalStatus === 'RETURNED'
    || badges.some((badge) => RETURN_BADGES.has(text(record(badge).title, 100).toLocaleLowerCase('de-CH')));
}

/**
 * One item of the tracker's reply, `mailpieces[]` of the search or the item's own detail, and its
 * scans (the detail's `events`).
 */
export function parseSwissPostShipment(item: JsonObject, rawEvents: unknown[] = []): CarrierResult {
  const summary = record(item.status);
  const globalStatus = text(summary.status, 100);
  let status: CarrierStatus = STATUS_MAP.get(globalStatus) ?? 'in_transit';
  const destination = destinationCountry(item);
  const abroad = destination && destination !== 'CH' && text(item.international, 20) === 'EXPORT' ? destination : null;
  const imported = text(item.international, 20) === 'IMPORT';
  const events: CarrierEvent[] = [];
  for (const rawEvent of rawEvents.slice(0, MAX_EVENTS_TO_INSPECT)) {
    if (!isRecord(rawEvent)) continue;
    const time = withSeconds(text(rawEvent.timestamp, 100));
    const code = text(rawEvent.code, 20);
    if (!time || !code) continue;
    const description = eventDescription(rawEvent, code);
    const event: CarrierEvent = {
      time: preAdviceClock(code, originClock(rawEvent, destinationClock(rawEvent, code, time, abroad), imported)),
      location: eventLocation(rawEvent),
      description,
      provider_code: providerCode(item, code),
    };
    const stage = swissPostRevoked(description) ? undefined : swissPostEventStage(code);
    if (stage) event.stage = stage;
    events.push(event);
  }
  // Swiss Post can list one scan twice at one instant, once with its place and once without;
  // the copy without a place adds nothing.
  const scan = (event: CarrierEvent) => [event.provider_code, event.time, event.description, event.stage].join('\u0000');
  const placed = new Set(events.filter((event) => event.location).map(scan));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!events[index]!.location && placed.has(scan(events[index]!))) events.splice(index, 1);
  }
  // The whole history is ordered before it is capped, so the newest scans are the ones kept.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => timestamp(right.time ?? '') - timestamp(left.time ?? ''));
  const truncated = rawEvents.length > MAX_EVENTS_TO_INSPECT || events.length > MAX_EVENTS_TO_RETURN;
  // The newest scan's own stage leads; the shipment summary fills in when that
  // scan has none (an enquiry note, an unmapped code, or no scans at all).
  let stage: Stage | undefined = (events[0]?.stage as Stage | undefined) ?? GLOBAL_STATUS_STAGE[globalStatus];
  // A shipment sent back reads "Delivered" once it reaches its sender again;
  // the summary is what says it came back.
  if (sentBack(item, globalStatus) && (!events[0]?.stage || stage === 'delivered')) stage = 'returned';
  if (stage === 'in_transit' && heldForPickup(events)) stage = 'ready_for_pickup';
  if (stage && STAGE_STATUS[stage]) status = STAGE_STATUS[stage]!;
  let lastStatusText: string;
  let lastUpdate: string | null;
  if (events[0]) {
    lastStatusText = events[0].description ?? 'Tracking update';
    lastUpdate = events[0].time ?? null;
  } else {
    lastStatusText = globalStatus;
    lastUpdate = withSeconds(text(item.lastUpdateTimestamp, 100)) || null;
  }
  const finished = stage === 'delivered' || stage === 'returned';
  const deliveredTimestamp = withSeconds(text(summary.deliveredTimestamp, 100));
  const deliveredAt = status === 'delivered'
    ? (/T\d{2}:\d{2}/.test(deliveredTimestamp) ? deliveredTimestamp : events[0]?.time ?? null)
    : null;
  const weight = weightKg(item);
  const dimensions = dimensionsText(item);
  const expected = finished ? null : swissPostExpectedDelivery(summary);
  const receiver = addressLines(item.recipientAddress);
  const international = comparableShipmentNumber(item.internationalMailpieceId);
  return {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: lastStatusText,
    last_update: lastUpdate,
    expected_delivery: expected?.to ?? null,
    ...(expected?.from ? { expected_delivery_from: expected.from } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(receiver ? { receiver_address: receiver } : {}),
    timezone: 'Europe/Zurich',
    global_status: globalStatus,
    canonical_tracking_number: comparableShipmentNumber(item.mailpieceId) || undefined,
    ...(/^[A-Z0-9]{4,40}$/.test(international) ? { international_tracking_number: international } : {}),
    // The summary without its events, as when their call fails; a provider may hold them.
    ...(events.length ? {} : { summary_only: true }),
    ...(truncated ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS_TO_RETURN),
  };
}

export class SwissPostTracker {
  readonly #fetcher: typeof fetch | undefined;

  constructor(options: SwissPostOptions = {}) {
    this.#fetcher = options.fetcher;
  }

  /**
   * A call of the lookup, sent once more if it fails to reach Swiss Post or hangs: the first gets
   * at most half of what is left, so the second fits in the rest.
   */
  #read(url: string, language: SwissPostLanguage, budget: LookupBudget): Promise<unknown> {
    const fetcher = this.#fetcher ?? fetch;
    return withNetworkRetry(budget, async (timeoutMs) => {
      const { bytes } = await swissPostReply(url, { headers: headers(language) }, budget.signal,
        Math.min(REQUEST_TIMEOUT_MS, timeoutMs, budget.remainingMs()), fetcher);
      return swissPostJson(bytes);
    });
  }

  /** The shipment, its scans worded in `language`. */
  async fetch(trackingNumber: string, context: TrackingContext = {}, language: SwissPostLanguage = 'en'): Promise<CarrierResult> {
    const budget = lookupBudget(context, DEFAULT_BUDGET_MS);
    const requested = comparableShipmentNumber(trackingNumber);
    const found = await this.#read(searchUrl(requested), language, budget);
    const items = isRecord(found) ? found.mailpieces : undefined;
    if (!Array.isArray(items) || !items.every(isRecord)) throw new SchemaError(PROVIDER, 'Swiss Post returned an invalid shipment response');
    if (items.length === 0) throw new NotFoundError(PROVIDER);
    const identified = items.filter((candidate) => comparableShipmentNumber(candidate.mailpieceId));
    if (identified.length === 0) throw new SchemaError(PROVIDER, 'Swiss Post did not return a shipment identifier');
    // The search answers an item's own number and the international number it was given abroad.
    const matches = identified.filter((candidate) => comparableShipmentNumber(candidate.mailpieceId) === requested
      || comparableShipmentNumber(candidate.internationalMailpieceId) === requested);
    if (matches.length === 0) throw new SchemaError(PROVIDER, 'Swiss Post returned a different shipment');
    if (matches.length !== 1) throw new SchemaError(PROVIDER, 'Swiss Post returned an ambiguous shipment');
    const item = matches[0]!;
    const key = text(item.mailpieceKey, 200);
    let detail: JsonObject | null = null;
    if (key) {
      try {
        const payload = await this.#read(detailUrl(key), language, budget);
        if (isRecord(payload) && Array.isArray(payload.events)) detail = payload;
      } catch (error) {
        // The search's summary is still useful when the item's own call fails.
        if (ended(budget)) throw error;
      }
    }
    if (detail && comparableShipmentNumber(detail.mailpieceId) !== comparableShipmentNumber(item.mailpieceId)) {
      throw new SchemaError(PROVIDER, 'Swiss Post returned a different shipment');
    }
    return detail ? parseSwissPostShipment(detail, detail.events as unknown[]) : parseSwissPostShipment(item);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwissPostTracker({ fetcher: environment.fetcher });
  return {
    id: 'swiss-post',
    steps: ['direct'],
    // Swiss Post words its scans in the reader's language when it has one, else in English.
    track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, SWISS_POST_LANGUAGES) ?? 'en'),
  };
};
