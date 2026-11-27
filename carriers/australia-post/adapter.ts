
import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { windowEstimate, type WindowEstimate } from '../../core/result/window.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { furtherAlong } from '../../core/status/progress.js';
import { DirectRest } from '../../core/runner/directRest.js';
import { recoverableByDefault, runSteps, type StepContext } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { canadaProvinceTimeZone, countryCode, countryTimeZone, explicitOffsetTime, epochMillisTime, isoTime,
  mislabeledLocalTime, mislabeledWallTime, usStateTimeZone } from '../../core/time/index.js';
import { clean, fetchBounded, TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { envChoice, envPositive } from '../../core/adapter/envChoice.js';
import { budgetWhenOutOfTime, trawlOutOfTime } from '../../core/transport/trawl.js';
import { australiaPostCode, australiaPostCodeParts, australiaPostStatus } from './status.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { DailyShare } from '../../core/transport/dailyShare.js';

const PROVIDER = 'Australia Post';
const DETAIL = 'https://auspost.com.au/mypost/track/details/';
const ENDED = new Set(['delivered', 'returned', 'ready_for_pickup']);
// Stages a scan reaches only once the parcel has moved.
const MOVED = new Set<string>(['in_transit', 'customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup']);
const API = 'https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments';
const MAX_BYTES = 1_000_000;
const DIRECT_TIMEOUT_MS = 10_000;
const RETRY_MIN_BROWSER_MS = 8_000;
/**
 * Browser time for a read another route can follow. Answered reads take at most about 13 s; a route
 * whose page hangs would otherwise hold the whole budget and leave the next route none. The cut
 * applies only while the next read still fits after it, with time for the browser service's reply.
 */
const ROUTE_READ_MS = 20_000;
const ROUTE_REPLY_MS = 1_000;
/**
 * How long `adaptive` sends first reads through the proxy after the original route was refused.
 * Refusals come in spells, and the retry after one starts with what the refusal left of the budget,
 * so it often runs out. A short window spares the next reads that loss; a longer one mostly slows
 * reads the original route would answer sooner, and adds proxy requests.
 */
const ADAPTIVE_WINDOW_MS = 15 * 60_000;
// Match the official Android app's HTTP client and channel. DataDome can still
// challenge this request; fetch's default `Accept-Language: *` also causes refusals.
const APP_HEADERS = { Accept: 'application/json', 'Accept-Language': 'en-AU', AP_APP_ID: 'MYPOST', AP_CHANNEL_NAME: 'ANDROID',
  'User-Agent': 'okhttp/4.12.0' };
// fetch's `no-store` adds a browser reload's cache headers and `no-cache` a `max-age=0`, which
// the gateway refuses from this client. The app sends neither, and Node's fetch keeps no cache.
const asApp = (fetcher?: typeof fetch): typeof fetch => (input, init) => (fetcher ?? fetch)(input, { ...init, cache: 'default' });

// A prepaid satchel's or label's barcode; other carriers' rules take any 22 digits.
const PREPAID_BARCODE = /^0[0-3]\d{20}$/;

/** A number worth a browser lookup: one Australia Post issues, and a prepaid barcode only with its GS1 check digit. */
function worthBrowserLookup(number: string): boolean {
  if (!accepted(() => normalizeAustraliaPostNumber(number))) return false;
  const normalized = normalizeAustraliaPostNumber(number);
  return !PREPAID_BARCODE.test(normalized) || hasGs1CheckDigit(normalized);
}

export function normalizeAustraliaPostNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{10,34}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Australia Post requires a 10-to-34-character tracking number');
  }
  return number;
}

export function australiaPostTrackingUrl(raw: string): string {
  return `${DETAIL}${normalizeAustraliaPostNumber(raw)}`;
}

export function australiaPostApiUrl(raw: string): string {
  return `${API}?${new URLSearchParams({ trackingIds: normalizeAustraliaPostNumber(raw) })}`;
}

function country(block: unknown): string | null {
  return isRecord(block) ? countryCode(clean(block.country, 60)) : null;
}

/** The zone of a scan abroad: a country its location names, its US state or Canadian province, else a single-zone country. */
function abroadZone(location: string, abroad: string): string | null {
  const named = countryCode(location.split(',').pop()?.replace(/\(.*?\)/g, '').trim());
  if (named && named !== abroad) return countryTimeZone(named);
  const region = /\s([A-Z]{2})$/.exec(location)?.[1];
  if (region && abroad === 'US') return usStateTimeZone(region);
  if (region && abroad === 'CA') return canadaProvinceTimeZone(region);
  return countryTimeZone(abroad);
}

/**
 * The air carrier's arrival in the destination ("Landed in Germany", "Arrived at postal carrier's
 * facility in Germany") carries that country's wall clock under Australia's offset: on parcels to
 * Europe its digits came within the hour of the destination post's own arrival scan, which came
 * ten hours after it as labelled.
 */
const DESTINATION_ARRIVALS = new Set(['INT-2164', 'INT-2165']);
function arrivalZone(code: string, description: string, abroad: string | null): string | null {
  if (!abroad || !DESTINATION_ARRIVALS.has(code)) return null;
  return countryCode(/\bin\s+([^,]+)$/i.exec(description)?.[1]?.trim()) === abroad ? countryTimeZone(abroad) : null;
}

/** Scans that leave the parcel at an Australian post office or parcel locker for collection. */
const COLLECTION_SCANS = new Set(['DD-ER4', 'NT-ER4']);
/** Deliveries left in a safe place, at the door. */
const SAFE_PLACE = new Set(['DD-ER15', 'DD-ER38']);
/** A scan's event code, without the milestone label its provider code adds. */
const eventCode = (event: CarrierEvent) => australiaPostCodeParts(event.provider_code ?? '').code;

/**
 * The post office or locker its awaiting-collection scan names: the newest scan while the
 * parcel waits there, or the scan just before its delivery once it is collected there. A
 * delivery left in a safe place was not collected.
 */
function collectionPoint(stage: string | undefined, events: readonly CarrierEvent[]): string | undefined {
  const index = events.findIndex((event) => event.stage !== 'delivered');
  const placed = stage === 'ready_for_pickup' ? index === 0
    : stage === 'delivered' && index > 0 && !events.slice(0, index).some((event) => SAFE_PLACE.has(eventCode(event)));
  const scan = placed ? events[index] : undefined;
  if (!scan || !COLLECTION_SCANS.has(eventCode(scan))) return undefined;
  return /^Awaiting collection at (.+)$/i.exec(scan.description ?? '')?.[1]?.trim() || undefined;
}

/** The one lookup entry and article must independently match the submitted reference. */
export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeAustraliaPostNumber(trackingNumber);
  if (!Array.isArray(payload) || !payload.length || payload.length > 20 || payload.some((entry) => !isRecord(entry))) {
    throw new SchemaError(PROVIDER, 'Australia Post returned an invalid tracking response');
  }
  const entries = payload.filter(isRecord).filter((entry) => Array.isArray(entry.trackingIds) && entry.trackingIds.includes(number));
  if (entries.length !== 1) throw new SchemaError(PROVIDER, 'Australia Post returned a different or ambiguous lookup');
  const entry = entries[0]!;
  // The gateway answers a reference it cannot process with an internal error, which says
  // nothing about the parcel.
  if (entry.status === 500 && entry.shipment === undefined) throw new IndeterminateError(PROVIDER);
  if (entry.status === 400 && isRecord(entry.error) && entry.error.errorCode === 21
    && entry.error.error === 'Invalid Tracking ID' && entry.error.status === 'Failed'
    && entry.shipment === undefined) throw new NotFoundError(PROVIDER);
  if (entry.status !== 200 || !isRecord(entry.shipment) || entry.shipment.status !== 'Success') {
    throw new SchemaError(PROVIDER, 'Australia Post could not confirm the shipment');
  }
  const shipment = entry.shipment;
  if (typeof shipment.consignmentId !== 'string' || !shipment.consignmentId
    || !Array.isArray(shipment.articles) || !shipment.articles.length || shipment.articles.length > 100
    || shipment.articles.some((article) => !isRecord(article))) {
    throw new SchemaError(PROVIDER, 'Australia Post returned invalid articles');
  }
  const articles = shipment.articles.filter(isRecord);
  const matches = articles.filter((article) => article.articleId === number);
  // A consignment can contain several independent deliveries. An exact article answers for
  // itself, and a consignment through its articles.
  if (matches.length === 1) return articleResult(matches[0]!, shipment.consignmentId);
  if (!matches.length && shipment.consignmentId === number) {
    return articles.length === 1 ? articleResult(articles[0]!, number) : consignmentResult(articles, number);
  }
  throw new SchemaError(PROVIDER, 'Australia Post returned a different or ambiguous article');
}

/**
 * A consignment of several articles answers as one parcel only while they are in one state:
 * every article delivered, or every newest scan coded, worded and placed alike, though each
 * article is scanned at its own moment. The consignment reached that state with its last
 * article, whose history answers. Articles in different states leave it inconclusive, since
 * one delivered sibling doesn't mean the others are.
 */
function consignmentResult(articles: readonly Record<string, unknown>[], consignmentId: string): CarrierResult {
  const results: CarrierResult[] = [];
  for (const article of articles) {
    try {
      results.push(articleResult(article, consignmentId));
    } catch (error) {
      // An article without history is in a state of its own.
      if (!(error instanceof IndeterminateError)) throw error;
    }
  }
  const state = ({ status, current_stage, last_status_text, events }: CarrierResult) => status === 'delivered' ? status
    : JSON.stringify([status, current_stage, last_status_text, ...['provider_code', 'description', 'location', 'stage'].map((key) => events?.[0]?.[key])]);
  if (results.length < articles.length || new Set(results.map(state)).size > 1) {
    throw new IndeterminateError(PROVIDER, 'Australia Post lists articles in different states under this consignment', { reason: 'several_parcels' });
  }
  const reached = (result: CarrierResult) => Date.parse(result.last_update ?? '') || 0;
  return results.reduce((last, result) => reached(result) > reached(last) ? result : last);
}

const SLOT_CLOCK = /^([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/;
const SLOT_OFFSET = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * The slot a `timeWindow` gives on its `deliveryDate`, from `start` to `end` (HHmmss), at the
 * offset its `timeZone` states, else on that day's wall clock. Once `passedWindow` says the slot
 * is over, the day alone stands. Null for a window in another shape.
 */
function slotEstimate(slot: unknown): WindowEstimate | null {
  if (!isRecord(slot) || typeof slot.deliveryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(slot.deliveryDate)) return null;
  const day = slot.deliveryDate;
  const offset = typeof slot.timeZone === 'string' && SLOT_OFFSET.test(slot.timeZone) ? slot.timeZone : '';
  const at = (clock: unknown) => {
    const match = typeof clock === 'string' ? SLOT_CLOCK.exec(clock) : null;
    return match ? `${day}T${match[1]}:${match[2]}:${match[3]}${offset}` : null;
  };
  const [start, end] = [at(slot.start), at(slot.end)];
  const estimate = slot.passedWindow === true || !start || !end ? windowEstimate(null, day) : windowEstimate(start, end);
  return estimate.expected_delivery ? estimate : null;
}

/**
 * When an article's details expect delivery: the slot on the day (`timeWindow`) the courier's
 * run gives, else the days `estimatedDeliveryDateRange` gives from its `fromDate` to its
 * `toDate`, else the day they expect it by, `deliveredByDateISO`; with the estimate fields they
 * fill that are not read, a countdown on the run (`minutesAway`, `stopsAway`) and whether it runs on
 * time (`onTimeStatus`) among them.
 */
function deliveryEstimate(details: Record<string, unknown>): { estimate: WindowEstimate; unread: Pick<CarrierResult, 'unread_estimates'> } {
  const range = isRecord(details.estimatedDeliveryDateRange) ? details.estimatedDeliveryDateRange : {};
  const window = windowEstimate(range.fromDate, range.toDate);
  const slot = slotEstimate(details.timeWindow);
  const run = slot && isRecord(details.timeWindow) ? details.timeWindow : {};
  return {
    estimate: slot ?? (window.expected_delivery ? window : windowEstimate(null, details.deliveredByDateISO)),
    unread: unreadEstimates({ estimatedDeliveryDateRange: window.expected_delivery || slot ? null : details.estimatedDeliveryDateRange,
      timeWindow: slot ? null : details.timeWindow, 'timeWindow.minutesAway': run.minutesAway, 'timeWindow.stopsAway': run.stopsAway,
      'timeWindow.onTimeStatus': run.onTimeStatus }),
  };
}

/** One article's history and state; its single detail object must repeat the article and consignment. */
function articleResult(selected: Record<string, unknown>, consignmentId: string): CarrierResult {
  if (typeof selected.articleId !== 'string' || !selected.articleId || !Array.isArray(selected.details)
    || selected.details.length !== 1 || !isRecord(selected.details[0])) {
    throw new SchemaError(PROVIDER, 'Australia Post returned invalid article details');
  }
  const details = selected.details[0];
  if (details.articleId !== selected.articleId || details.consignmentId !== consignmentId) {
    throw new SchemaError(PROVIDER, 'Australia Post returned mismatched article details');
  }
  // A known article without scans, shown as "Updating Status": its history is gone or never began,
  // as for a label not yet scanned. Australia Post has answered for it, so it is no outage.
  if (Array.isArray(details.events) && !details.events.length) throw new NoHistoryError(PROVIDER, 'Australia Post shows no history for this article', { reason: 'listed' });
  if (!Array.isArray(details.events) || details.events.length > 500) {
    throw new SchemaError(PROVIDER, 'Australia Post returned incomplete tracking history');
  }
  // Australia Post's own scans carry their offset. Those it relays from the post
  // abroad carry that office's wall clock labelled as UTC.
  const destination = country(details.address);
  // The product as the page names it ("Parcel Post Large Satchel"); its family alone names no service.
  const service = clean(details.productSubType, 80);
  const crossings = [...new Set([destination, country(details.fromAddress)].filter((code) => code && code !== 'AU'))];
  const abroad = crossings.length === 1 ? crossings[0]! : null;
  const events: Array<{ event: CarrierEvent; timestamp: number; classified?: ClassifiedStatus }> = [];
  const zones = new Set<string>();
  const seen = new Set<string>();
  for (const raw of details.events) {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event');
    const offset = explicitOffsetTime(raw.localeDateTime);
    const epoch = typeof raw.dateTime === 'number' && Number.isSafeInteger(raw.dateTime) && raw.dateTime > 100_000_000_000
      ? epochMillisTime(raw.dateTime) : null;
    if (offset && epoch && offset.timestamp !== epoch.timestamp) throw new SchemaError(PROVIDER, 'Australia Post returned conflicting event dates');
    if (!(offset ?? epoch)) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event date');
    const code = clean(raw.eventCode, 64);
    const description = clean(raw.description);
    const location = clean(raw.location, 200);
    if (!description) throw new SchemaError(PROVIDER, 'Australia Post returned an empty event');
    const arrival = offset ? arrivalZone(code, description, abroad) : null;
    const zone = arrival ?? (abroad && offset?.iso.endsWith('Z') ? abroadZone(location, abroad) : undefined);
    if (zone) zones.add(zone);
    const at = arrival ? isoTime(String(raw.localeDateTime).replace(/(?:Z|[+-]\d{2}:?\d{2})$/, ''), arrival)
      : zone ? mislabeledLocalTime(raw.localeDateTime, zone) : offset ?? epoch;
    // Without a zone the wall clock stays local; its label still orders it as the reply does.
    const wall = zone === null ? mislabeledWallTime(raw.localeDateTime)?.replace(/\.000$/, '') : undefined;
    if (!at) throw new SchemaError(PROVIDER, 'Australia Post returned an invalid event date');
    const milestone = clean(raw.milestone, 64);
    const classified = australiaPostStatus(milestone, code);
    const event: CarrierEvent = { ...(wall ? { local_time: wall } : { time: at.iso }),
      description: classified?.stage === 'delivered' ? 'Delivered' : description,
      ...(location ? { location } : {}), ...(classified ? { stage: classified.stage } : {}),
      ...(/^[A-Z0-9_-]{1,64}$/.test(code) ? { provider_code: australiaPostCode(code, milestone) } : {}),
    };
    const key = JSON.stringify([at.timestamp, event.description, location, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ event, timestamp: at.timestamp, ...(classified ? { classified } : {}) });
  }
  // A scan abroad can come twice at one instant, placed once by its country alone and once by its town and country
  // ("International arrival - awaiting clearance"): the copy with the country alone is left out.
  const coarser = ({ event, timestamp }: typeof events[number], other: typeof events[number]) => other.timestamp === timestamp
    && other.event.description === event.description && other.event.provider_code === event.provider_code
    && !!event.location && !!other.event.location?.endsWith(`, ${event.location}`);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events.some((other) => coarser(events[index]!, other))) events.splice(index, 1);
  }
  // A wall clock without a zone sorts on the clock the reply's other scans abroad keep, when they keep one.
  const keeping = zones.size === 1 ? [...zones][0]! : null;
  for (const entry of keeping ? events : []) {
    if (typeof entry.event.local_time === 'string') entry.timestamp = isoTime(entry.event.local_time, keeping!)?.timestamp ?? entry.timestamp;
  }
  if (listsNewestFirst(events.map(({ event }) => event)) === false) events.reverse();
  events.sort((a, b) => b.timestamp - a.timestamp);
  // The receipt for transport to a processing facility (DOM-0046) is the acceptance when no scan moved the parcel before
  // it: a parcel lodged in Australia, or one a forwarder cleared in. After scans abroad it is the parcel going on.
  const firstMove = [...events].reverse().find(({ classified }) => classified && classified.stage !== 'registered');
  if (firstMove && australiaPostCodeParts(String(firstMove.event.provider_code ?? '')).code === 'DOM-0046') {
    firstMove.classified = { stage: 'accepted', status: 'in_transit' };
    firstMove.event.stage = 'accepted';
  }
  // A lodging told again after a scan moved the parcel, a day after it left Australia, is the parcel going on.
  let moved = false;
  for (const entry of [...events].reverse()) {
    if (moved && entry.classified?.stage === 'accepted') {
      entry.classified = { stage: 'in_transit', status: 'in_transit' };
      entry.event.stage = 'in_transit';
    } else if (entry.classified && MOVED.has(entry.classified.stage)) moved = true;
  }
  const summary = clean(selected.trackStatusOfArticle)
    || (isRecord(selected.status) ? clean(selected.status.statusAttributeValue) : '');
  if (!summary) throw new SchemaError(PROVIDER, 'Australia Post returned no article status');
  // A summary the map does not know ("Despatched" abroad) takes the newest scan's stage. A summary
  // label groups several scans ("In transit" covers customs on the way in): the newest scan's event
  // code places the parcel further along when the map lists it. A summary that stages the parcel as
  // that scan's own milestone does ("In transit" over an acceptance abroad filed under "It's on its
  // way") says no more than the scan, so its code stands either way.
  const latest = events[0]!;
  const labelled = australiaPostStatus(summary);
  const { code: latestCode, milestone: latestMilestone } = australiaPostCodeParts(String(latest.event.provider_code ?? ''));
  const coded = australiaPostStatus('', latestCode) && latest.classified;
  const echoed = labelled && latestMilestone !== undefined && australiaPostStatus(latestMilestone)?.stage === labelled.stage;
  const status = labelled && coded && (echoed || furtherAlong(labelled.stage, coded.stage)) ? coded : labelled ?? latest.classified;
  const deliveredAt = status?.status === 'delivered' ? events.find(({ event }) => event.stage === 'delivered')?.event.time : null;
  // The reply names the point but gives no address for it.
  const pickup = collectionPoint(status?.stage, events.map(({ event }) => event));
  const { estimate, unread } = deliveryEstimate(details);
  // Summary modification/milestone timestamps are not scan times. In the
  // observed reply they differed from the delivery event by about ten hours.
  return {
    status: status?.status ?? 'unknown', ...(status ? { current_stage: status.stage } : {}),
    last_status_text: status?.status === 'delivered' ? 'Delivered' : summary,
    last_update: latest.event.time ?? null,
    ...(typeof latest.event.local_time === 'string' ? { last_update_local: latest.event.local_time } : {}),
    // The estimate stands until the parcel is delivered, returned or waits for collection.
    ...(status && ENDED.has(status.stage) ? { expected_delivery: null } : estimate), ...unread,
    ...(service ? { service_name: service } : {}), ...(pickup ? { pickup_point: pickup } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}), ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, 100).map(({ event }) => event),
  };
}

export interface AustraliaPostTrackerOptions {
  trawl: TrawlClient | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  recorder?: StepRecorder;
  /** A residential HTTP(S) proxy, paid by the byte: the last route, within its daily share. */
  fallbackProxyUrl?: string;
  /** Datacenter HTTP(S) proxies, as a list or separated by spaces or commas; each read takes one at random. */
  datacenterProxyUrls?: string | readonly string[];
  /**
   * Bytes a day the residential proxy may carry, charged 0.15 MB a read. 33 MB by default, about 1 GB
   * a month; `Infinity` leaves it unbounded.
   */
  residentialDailyBytes?: number;
  /**
   * Where the first browser read goes: the original route (`default`), the proxies (`residential`),
   * or the proxies for a while after the original route was refused (`adaptive`). The datacenter
   * proxies come before the residential one; a challenge moves the lookup to the next route.
   */
  firstRoute?: 'default' | 'residential' | 'adaptive';
}

const FIRST_ROUTES: ReadonlySet<unknown> = new Set(['default', 'residential', 'adaptive']);
type Route = 'default' | 'datacenter' | 'residential';
/**
 * What a read through the residential proxy is charged against its daily share. A filtered proxied
 * page measures about 0.11 MB; a read that also loads the app module or DataDome's device check costs more.
 */
const RESIDENTIAL_READ_BYTES = 150_000;
const RESIDENTIAL_DAILY_BYTES = 33_000_000;
const SPENT_WARNING_MS = 3_600_000;

export class AustraliaPostTracker {
  private readonly fallbackProxy: string | null;
  private readonly datacenterProxies: readonly string[];
  private readonly share: DailyShare;
  private readonly firstRoute: NonNullable<AustraliaPostTrackerOptions['firstRoute']>;
  /** Until when, by `Date.now()`, an `adaptive` first read goes through the proxies. */
  private proxiesUntil = 0;
  private spentWarnedAt = -Infinity;

  constructor(private readonly options: AustraliaPostTrackerOptions) {
    const proxy = options.fallbackProxyUrl?.trim() || null;
    if (proxy) browserContextProxy(proxy);
    this.fallbackProxy = proxy;
    const listed = typeof options.datacenterProxyUrls === 'string' ? options.datacenterProxyUrls.split(/[\s,]+/) : options.datacenterProxyUrls ?? [];
    this.datacenterProxies = listed.map(value => value.trim()).filter(Boolean);
    for (const value of this.datacenterProxies) browserContextProxy(value);
    const daily = options.residentialDailyBytes ?? RESIDENTIAL_DAILY_BYTES;
    if (typeof daily !== 'number' || !(daily > 0)) throw new TypeError('Australia Post residential daily bytes must be a positive number');
    this.share = new DailyShare(daily, RESIDENTIAL_READ_BYTES);
    if (options.firstRoute !== undefined && !FIRST_ROUTES.has(options.firstRoute)) {
      throw new TypeError('Australia Post first route must be default, residential or adaptive');
    }
    this.firstRoute = proxy || this.datacenterProxies.length ? options.firstRoute ?? 'default' : 'default';
  }

  private spent(): void {
    const now = Date.now();
    if (now - this.spentWarnedAt < SPENT_WARNING_MS) return;
    this.spentWarnedAt = now;
    console.warn('Australia Post: the residential proxy has used its daily share; it carries no read until the share refills');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAustraliaPostNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Australia Post budget must be between 1 and 60000 ms');
    context.signal?.throwIfAborted();
    const trawl = this.options.trawl;
    const deadline = performance.now() + budgetMs;
    const proxyFirst = this.firstRoute === 'residential' || (this.firstRoute === 'adaptive' && Date.now() < this.proxiesUntil);
    // Cheapest first: the original route, then the datacenter proxies, then the residential one while
    // its share lasts; inside a refusal spell the proxies come first.
    const proxies: Route[] = [...(this.datacenterProxies.length ? ['datacenter' as const] : []),
      ...(this.fallbackProxy ? ['residential' as const] : [])];
    let order: Route[] = proxyFirst ? [...proxies, 'default'] : ['default', ...proxies];
    if (this.fallbackProxy && !this.share.affords()) {
      order = order.filter(next => next !== 'residential');
      this.spent();
    }
    let taken = 0;
    const nextRoute = (): Route | null => {
      while (taken < order.length) {
        const next = order[taken++]!;
        if (next !== 'residential' || this.share.take()) return next;
        this.spent();
      }
      return null;
    };
    let route: Route = 'default';
    let reads = 0;
    let history = false;
    const recorder = this.options.recorder;
    const routed: StepRecorder | undefined = recorder && proxies.length ? {
      step: record => recorder.step(record.step === 'trawl' ? { ...record, networkRoute: route,
        networkAttempt: reads > 1 ? 'retry' : 'initial', historyAvailable: history } : record),
      lookup: record => recorder.lookup(record),
    } : recorder;
    // The browser service's own server errors: such a read carries no word from Australia Post.
    const serviceFailures = new WeakSet<object>();
    // Reads cut short so the next route keeps time: such a read says nothing about the parcel.
    const routeTimeouts = new WeakSet<object>();
    const browser = async (signal: AbortSignal, remainingMs: number, next: Route): Promise<CarrierResult> => {
      const available = Math.floor(remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS);
      if (available < 1) throw new BudgetExceededError(PROVIDER, budgetMs);
      const capped = taken < order.length && available > ROUTE_READ_MS
        && remainingMs - ROUTE_READ_MS - ROUTE_REPLY_MS >= TRAWL_TRANSPORT_ALLOWANCE_MS + RETRY_MIN_BROWSER_MS;
      const timeoutMs = capped ? ROUTE_READ_MS : available;
      const proxy = next === 'residential' ? this.fallbackProxy
        : next === 'datacenter' ? this.datacenterProxies[Math.floor(Math.random() * this.datacenterProxies.length)]! : null;
      route = next; reads++; history = false;
      const apiUrl = australiaPostApiUrl(number);
      // A capped read ends on our side at its cap and the reply's allowance, even when the service sends
      // nothing back, so the next route keeps the time reserved for it.
      const cap = capped ? new AbortController() : null;
      const timer = cap ? setTimeout(() => cap.abort(new DOMException('The route read reached its cap', 'TimeoutError')),
        timeoutMs + ROUTE_REPLY_MS) : undefined;
      const stop = () => clearTimeout(timer);
      signal.addEventListener('abort', stop, { once: true });
      const page = await trawl!.scrape({ url: australiaPostTrackingUrl(number), skipHttp: true, maxTier: 3,
        maxTimeout: timeoutMs, captureResponses: [apiUrl], ...(proxy ? { proxy } : {}), settleTimeout: Math.min(timeoutMs, 10_000),
      }, { provider: 'TRAWL while fetching Australia Post', timeoutMs, signal: cap ? AbortSignal.any([signal, cap.signal]) : signal,
        maxBytes: 6_000_000, requireSolved: false })
        .catch((error: unknown) => {
          if (cap?.signal.aborted && !signal.aborted) {
            const failure = new BudgetExceededError(PROVIDER, budgetMs, { cause: error });
            routeTimeouts.add(failure);
            throw failure;
          }
          if (error instanceof UpstreamHttpError && error.status >= 500 && !trawlOutOfTime(error)) serviceFailures.add(error);
          try { return budgetWhenOutOfTime(PROVIDER, budgetMs)(error); } catch (failure) {
            if (capped && failure instanceof BudgetExceededError) routeTimeouts.add(failure);
            throw failure;
          }
        })
        .finally(() => { stop(); signal.removeEventListener('abort', stop); });
      signal.throwIfAborted();
      if (![2, 3].includes(page.tier) || ![200, 304].includes(page.statusCode)) {
        throw new TransportError(PROVIDER, 'The browser service did not load Australia Post tracking');
      }
      const captures = page.capturedResponses.filter((capture) => capture.url === apiUrl && capture.status !== 204);
      if (!captures.length || captures.length > 20) throw new TransportError(PROVIDER, 'Australia Post returned no matching browser response');
      const capture = captures[captures.length - 1]!;
      if (capture.status === 429) {
        throw new RateLimitedError(PROVIDER, retryAfterMs(capture.headers['retry-after'], { dates: false }));
      }
      if ([401, 403].includes(capture.status)) {
        throw new ChallengeError(PROVIDER, `Australia Post tracking API returned HTTP ${capture.status}`,
          { status: capture.status, reason: `http_${capture.status}` });
      }
      if (capture.status >= 400) throw new UpstreamHttpError(PROVIDER, capture.status);
      if (capture.status !== 200 || capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
        throw new TransportError(PROVIDER, 'Australia Post returned an incomplete browser response');
      }
      if (Buffer.byteLength(capture.body, 'utf8') > MAX_BYTES) throw new SchemaError(PROVIDER, 'Australia Post returned an unexpectedly large response');
      let payload: unknown;
      try { payload = JSON.parse(capture.body); } catch { throw new SchemaError(PROVIDER, 'Australia Post returned invalid tracking JSON'); }
      const result = parse(payload, number);
      history = !!result.events?.length;
      return result;
    };
    const read = async (signal: AbortSignal, remainingMs: number, previousError: unknown): Promise<CarrierResult> => {
      const next = nextRoute();
      // Only when a concurrent lookup took the residential share this one counted on.
      if (next === null) throw previousError instanceof Error ? previousError : new ChallengeError(PROVIDER);
      try {
        return await browser(signal, remainingMs, next);
      } catch (error) {
        // Each refusal or hang on the original route starts the window again.
        if (next === 'default' && (error instanceof ChallengeError || (error instanceof Error && routeTimeouts.has(error)))
          && this.firstRoute === 'adaptive') this.proxiesUntil = Date.now() + ADAPTIVE_WINDOW_MS;
        throw error;
      }
    };
    // The next route after a challenge, or after a read cut short for it. A read through a proxy also
    // moves on when the proxy fails to carry it or the browser service fails on it, so a proxy outage
    // leaves the other routes.
    const nextStep = (index: number) => ({
      id: 'trawl', enabled: trawl !== null && order.length > index,
      recovers: (error: unknown) => (error instanceof ChallengeError || (error instanceof Error && routeTimeouts.has(error))
        || (route !== 'default' && (carrierErrorKind(error) === 'transport' || (error instanceof Error && serviceFailures.has(error)))))
        && deadline - performance.now() >= TRAWL_TRANSPORT_ALLOWANCE_MS + RETRY_MIN_BROWSER_MS,
      run: ({ signal, remainingMs, previousError }: StepContext) => read(signal, remainingMs, previousError),
    });
    // A gateway that refuses plain HTTP refuses it for days: the browser step reads the parcel meanwhile.
    const rest = new DirectRest('australia-post', trawl);
    return runSteps({ carrier: 'australia-post', budgetMs, signal: context.signal, recorder: routed }, [{
      id: 'direct', enabled: !rest.resting, run: async ({ signal, remainingMs }) => {
        const { response, bytes } = await fetchBounded(australiaPostApiUrl(number), { signal, headers: APP_HEADERS }, {
          provider: PROVIDER, timeoutMs: Math.max(1, Math.min(DIRECT_TIMEOUT_MS, Math.floor(remainingMs))),
          maxBytes: MAX_BYTES, allowHttpStatuses: [401, 403, 429], fetcher: asApp(this.options.fetcher),
        });
        if (response.status === 429) {
          throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after'), { dates: false }));
        }
        if (response.status !== 200) {
          rest.refused();
          throw new ChallengeError(PROVIDER, trawl ? `Australia Post tracking API returned HTTP ${response.status}`
            : `Australia Post requires the browser tracking service (tracking API HTTP ${response.status})`,
          { status: response.status, reason: `http_${response.status}` });
        }
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SchemaError(PROVIDER, 'Australia Post returned invalid tracking JSON'); }
        return parse(payload, number);
      },
    }, {
      // The browser reads the same gateway, so it cannot improve on an inconclusive entry.
      enabled: trawl !== null, recovers: (error) => recoverableByDefault(error) && !(error instanceof IndeterminateError),
      id: 'trawl', run: ({ signal, remainingMs, previousError }) => read(signal, remainingMs, previousError),
    }, nextStep(1), nextStep(2)]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AustraliaPostTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder,
    fallbackProxyUrl: environment.env.AUSTRALIA_POST_FALLBACK_PROXY_URL,
    datacenterProxyUrls: environment.env.AUSTRALIA_POST_DATACENTER_PROXY_URLS,
    residentialDailyBytes: envPositive(environment.env, 'AUSTRALIA_POST_FALLBACK_PROXY_DAILY_BYTES', RESIDENTIAL_DAILY_BYTES),
    firstRoute: envChoice(environment.env, 'AUSTRALIA_POST_FIRST_ROUTE', ['default', 'residential', 'adaptive'], 'default') });
  // Recognition is plain HTTP: it asks the gateway alone, and a refusal there fails instead of starting a browser.
  // A recognition budget can be longer than the minute a lookup takes at most.
  const gateway = new AustraliaPostTracker({ trawl: null, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'australia-post', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => gateway.fetch(number, { ...context, budgetMs: Math.min(context?.budgetMs ?? 45_000, 60_000) }),
      () => accepted(() => normalizeAustraliaPostNumber(number))),
    // The gateway refuses plain HTTP from many networks, so the opt-in browser phase reads the parcel as a lookup
    // does: only a dated record confirms the number.
    recognizeWithBrowser: (number, context) => (worthBrowserLookup(number)
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, { ...context, budgetMs: Math.min(context?.budgetMs ?? 45_000, 60_000) }))
      : Promise.resolve({ known: false, lastActivityAt: null })) };
};
