
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecord, type StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { clean, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { STATE_PATTERN, uspsRowZone, uspsScanZone } from './clock.js';
import { uspsStage, uspsStatus } from './status.js';

/**
 * USPS, through the server-rendered tracking page.
 *
 * The `/tracking/{number}` page carries the verdict and collapsed history
 * in its HTML. The legacy query route can return only the global header,
 * so load the package path directly. The browser handles verification;
 * nothing is replayed over plain HTTP.
 */
const TRACKING_BASE = 'https://tools.usps.com/tracking/';
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';
const MAX_BYTES = 10_000_000;
// The browser's time for every read; with the transport allowance a lookup ends within a
// minute. Answers the page gives come well inside it.
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_EVENTS_TO_RETURN = 100;
/** Pages a second browser read within the same budget can complete. */
const RECOVERABLE_PAGES = new Set(['incomplete_page', 'interstitial_page']);

/** A read the verification wrapper sent to the outage page. */
function outageRedirect(error: unknown): boolean {
  return error instanceof IndeterminateError && error.reason === 'maintenance_page';
}

/**
 * Redirects come in runs: after three in a row, the next read is redirected more often than
 * not, whether it comes seconds or minutes later. So once three reads in a row through one
 * route land on the outage page, its reads pause for five minutes. The pause spares reads; it
 * does not wait a spell out, as a read twenty minutes on fares about as a read five minutes on.
 * While the browser service's own route is paused, reads go through the fallback proxy when one
 * is configured; otherwise lookups end before any read, as the adapter's own pacing
 * (`self_paced`) with the wait, so a consumer can hold its checks until then rather than count a
 * failure of USPS. The next read after the pause pauses them again if it is redirected too; a
 * loaded page ends the run.
 */
const OUTAGE_RUN = 3;
const OUTAGE_PAUSE_MS = 5 * 60_000;
interface OutageRun { redirects: number; pausedUntil: number }
const outageRuns = new Map<string, OutageRun>();

/** The route's run of redirects: the browser service's own address, or the proxy it reads through. */
function outageRun(trawl: TrawlClient, proxy: string | null = null): OutageRun {
  const key = proxy ? `${trawl.endpoint.href} ${proxy}` : trawl.endpoint.href;
  let run = outageRuns.get(key);
  if (!run) outageRuns.set(key, run = { redirects: 0, pausedUntil: 0 });
  return run;
}

type Route = NonNullable<StepRecord['networkRoute']>;

/** One lookup's reads: the latest one's route, or null when it made none, and whether it returned dated history. */
interface ReadRoute { route: Route | null; reads: number; history: boolean }

function pausedMs(run: OutageRun): number {
  return Math.max(0, run.pausedUntil - Date.now());
}

/** The number as typed, upper case and without the spaces, dots and dashes of a printed label. */
function cleanUSPSNumber(raw: string): string {
  return raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
}

export function normalizeUSPSNumber(raw: string): string {
  const value = cleanUSPSNumber(raw);
  const pic = uspsPackageIdentifier(value);
  if (pic) return pic;
  // The S10 suffix identifies the issuing country, not the destination.
  // Incoming international mail keeps that number when USPS takes over.
  if (!/^\d{20}$/.test(value) && !/^\d{22}$/.test(value) && !isValidS10TrackingNumber(value)) {
    throw new InvalidInputError('USPS', 'USPS tracking numbers must contain 20 or 22 digits, a checksum-valid IMpb, or a checksum-valid UPU S10 number');
  }
  return value;
}

export function uspsTrackingUrl(trackingNumber: string): string {
  return new URL(normalizeUSPSNumber(trackingNumber), TRACKING_BASE).toString();
}

const MONTHS = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_PATTERN = new RegExp(`${MONTHS}\\s+\\d{1,2},?\\s+\\d{4}`, 'i');
const TIME_PATTERN = /\d{1,2}:\d{2}(?::\d{2})?\s*[ap]\.?m\.?/i;
// Incoming international mail shows this undated from the origin post's electronic notice
// until USPS scans the item, past the origin post's later scans abroad and sometimes after
// the item arrives, so it cannot stand for the item's status while a scan is dated.
const ORIGIN_POST_NOTICE = /^origin post is preparing shipment\b/i;

function eventTime(dateText: string, timeText: string, location: string, description: string, readAt: number): { iso: string; timestamp: number } | null {
  const dateMatch = DATE_PATTERN.exec(dateText);
  const timeMatch = TIME_PATTERN.exec(timeText);
  if (!dateMatch || !timeMatch) return null;
  // Facility-local wall time lives in the event's own state.
  const zone = uspsScanZone(location);
  if (!zone) return null;
  const date = firstOccurrence(DateTime.fromFormat(dateMatch[0], 'MMMM d, yyyy', { locale: 'en-US', zone }));
  const clock = timeMatch[0].replace(/\./g, '').toLowerCase();
  const time = firstOccurrence(DateTime.fromFormat(clock, /:\d{2}:\d{2}/.test(clock) ? 'h:mm:ss a' : 'h:mm a', { locale: 'en-US', zone }));
  if (!date.isValid || !time.isValid) return null;
  const local = date.set({ hour: time.hour, minute: time.minute, second: time.second });
  // A label its mailer wrote on UTC.
  const own = uspsRowZone(local.toFormat("yyyy-MM-dd'T'HH:mm:ss"), zone, description, readAt);
  const at = own === zone ? local : local.setZone(own, { keepLocalTime: true });
  const iso = at.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: at.toMillis() } : null;
}

const DAY_PATTERN = new RegExp(`${MONTHS}\\s+(\\d{1,2}),?\\s+(\\d{4})|(\\d{1,2})\\s+${MONTHS}\\s+(\\d{4})`, 'i');
// A delivery window as USPS words it: "Expected Delivery Between 1:15pm and 4:15pm".
const WINDOW = /\bbetween\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s+(?:and|to|-|–)\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i;

/** The first calendar day `text` writes, "March 17, 2025" or "17 March 2025", and where it ends. */
function calendarDay(text: string): { day: string; end: number } | null {
  const match = DAY_PATTERN.exec(text);
  if (!match) return null;
  const [month, date, year] = match[1] ? [match[1], match[2], match[3]] : [match[5], match[4], match[6]];
  const day = DateTime.fromFormat(`${month} ${date} ${year}`, 'MMMM d yyyy', { locale: 'en-US', zone: 'utc' }).toISODate();
  return day ? { day, end: match.index + match[0].length } : null;
}

/** A 12-hour clock as HH:MM, or null when it is not one. */
function clock24(hour: string, minute: string, half: string): string | null {
  const value = Number(hour);
  if (value < 1 || value > 12 || Number(minute) > 59) return null;
  return `${String((value % 12) + (half.toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0')}:${minute}`;
}

/** `day` as a slot when `text` opens with its window ("between 1:15pm and 4:15pm"), else the day alone. */
function withWindow(day: string, text: string): string {
  const match = WINDOW.exec(text.slice(0, 80));
  const from = match ? clock24(match[1]!, match[2]!, match[3]!) : null;
  const to = match ? clock24(match[4]!, match[5]!, match[6]!) : null;
  return from && to && from < to ? `${day} ${from}–${to}` : day;
}

/** A delivery estimate the status text words, as its calendar day, with the window it gives after that day. */
function expectedDelivery(text: string): string | null {
  const heading = /(?:expected|scheduled|anticipated)\s+delivery/i.exec(text);
  const rest = heading ? text.slice(heading.index + heading[0].length) : '';
  const found = calendarDay(rest);
  return found ? withWindow(found.day, rest.slice(found.end)) : null;
}

/** The estimate banner's day, whatever its heading says, with the window it gives after that day. */
function bannerEstimate(text: string): string | null {
  const found = calendarDay(text);
  return found ? withWindow(found.day, text.slice(found.end)) : null;
}

/**
 * The delivery the newest scan announces when it sends the parcel out, on that scan's own day:
 * "Out for Delivery, Expected Delivery Between 1:15pm and 4:15pm" as a slot, "Out for Delivery,
 * Expected Delivery by 9:00pm" as the day.
 */
function roundEstimate(event: CarrierEvent | undefined): string | null {
  const description = event?.stage === 'out_for_delivery' ? event.description ?? '' : '';
  const heading = /\bexpected delivery\b/i.exec(description);
  const wall = typeof event?.time === 'string' ? event.time : typeof event?.local_time === 'string' ? event.local_time : '';
  const day = /^\d{4}-\d{2}-\d{2}(?=T|$)/.exec(wall)?.[0];
  return heading && day ? withWindow(day, description.slice(heading.index + heading[0].length)) : null;
}

/** The banner's or status text's estimate, or the round's when they give none or the same day without a window. */
function estimateOf(announced: string | null, round: string | null): string | null {
  if (!round || (announced && announced.slice(0, 10) !== round.slice(0, 10))) return announced;
  return announced && announced.length > round.length ? announced : round;
}

function notLocated(): CarrierResult {
  return {
    status: 'unknown',
    last_status_text: 'USPS could not locate the shipment',
    last_update: null,
    expected_delivery: null,
    events: [],
  };
}

interface ParsedRow {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

/** One history row, read by content pattern: a US date, a clock time, a
 * city/state location, and the longest remaining cell as the description. */
function parseRow(cells: string[], index: number, readAt: number): ParsedRow | null {
  const texts = cells.map((cell) => clean(cell, 500)).filter(Boolean);
  if (texts.length < 2) return null;
  const dateText = texts.find((text) => DATE_PATTERN.test(text)) ?? '';
  const timeText = texts.find((text) => TIME_PATTERN.test(text)) ?? '';
  // The description cell can echo the location; the location cell is the
  // shortest state-bearing one that carries no date.
  const location = texts
    .filter((text) => STATE_PATTERN.test(text) && !DATE_PATTERN.test(text))
    .sort((left, right) => left.length - right.length)[0] ?? '';
  const description = texts
    .filter((text) => text !== dateText && text !== timeText && text !== location)
    .sort((left, right) => right.length - left.length)[0] ?? '';
  if (!description) return null;
  const at = eventTime(dateText, timeText, location, description, readAt);
  const stage = uspsStage(description) ?? undefined;
  const rawTime = clean(dateText === timeText ? dateText : `${dateText} ${timeText}`, 64);
  return {
    event: {
      ...(at ? { time: at.iso } : rawTime ? { time: rawTime } : {}),
      ...(location ? { location: location.slice(0, 250) } : {}),
      // A delivered line may name who signed; the event keeps the fact, not the name.
      description: stage === 'delivered' ? 'Delivered' : description,
      ...(stage ? { stage } : {}),
    },
    timestamp: at?.timestamp ?? Number.NEGATIVE_INFINITY,
    index,
  };
}

/** Current USPS markup includes collapsed scans in the DOM, without a table.
 * Undated progress steps and the history-expansion control are not scans. */
function parseTimelineRow(description: string, dateText: string, location: string, readAt: number): CarrierEvent | null {
  if (!description || !DATE_PATTERN.test(dateText)) return null;
  const stage = uspsStage(description) ?? undefined;
  const at = eventTime(dateText, dateText, location, description, readAt);
  const date = DATE_PATTERN.exec(dateText)?.[0];
  const time = TIME_PATTERN.exec(dateText)?.[0];
  // UTC is only a parsing frame here. An unresolved location gets an offset-free
  // local_time, never a made-up UTC scan or another facility's timezone. A step
  // USPS dates by its day alone, as it does pre-shipment info, keeps that day.
  const local = date && time ? DateTime.fromFormat(
    `${date.replace(/,\s*/, ' ')} ${time.replace(/\./g, '').replace(/\s*([ap])m/i, ' $1m')}`,
    time.split(':').length === 3 ? 'MMMM d yyyy h:mm:ss a' : 'MMMM d yyyy h:mm a',
    { locale: 'en-US', zone: 'UTC' },
  ) : null;
  const day = date && !time ? DateTime.fromFormat(date.replace(/,\s*/, ' '), 'MMMM d yyyy', { locale: 'en-US', zone: 'UTC' }) : null;
  const wall = local?.isValid ? local.toFormat("yyyy-MM-dd'T'HH:mm:ss") : day?.isValid ? day.toISODate() : null;
  return {
    ...(at ? { time: at.iso } : wall ? { local_time: wall } : { raw_time: dateText }),
    ...(location ? { location: location.slice(0, 250) } : {}),
    description: stage === 'delivered' ? 'Delivered' : description,
    ...(stage ? { stage } : {}),
  };
}

/**
 * A shipping partner's parcel reaches USPS with an acceptance scan after the
 * partner has already moved it. That handoff is transit, not a second acceptance.
 * Events are newest first.
 */
function handoffsInTransit(events: CarrierEvent[]): CarrierEvent[] {
  const result = [...events];
  let moved = false;
  for (let index = result.length - 1; index >= 0; index--) {
    const event = result[index]!;
    if (event.stage === 'accepted' && moved) result[index] = { ...event, stage: 'in_transit' };
    else if (event.stage === 'in_transit' || event.stage === 'customs') moved = true;
  }
  return result;
}

// Stages a scan after the return started takes as part of the trip back to the sender.
const RETURN_TRIP = new Set(['accepted', 'in_transit', 'out_for_delivery', 'ready_for_pickup', 'delivered']);

/**
 * From the scan that starts a return ("Return to Sender Processed", "Refused"), the scans are the
 * trip back: they carry `provider_leg` `return`, and a movement or delivery among them is the
 * return under way, not a delivery to the recipient. Events are newest first.
 */
function returnLeg(events: CarrierEvent[]): CarrierEvent[] {
  const result = [...events];
  let returning = false;
  for (let index = result.length - 1; index >= 0; index--) {
    const event = result[index]!;
    if (event.stage === 'returned') returning = true;
    if (!returning) continue;
    const trip = RETURN_TRIP.has(event.stage ?? '');
    result[index] = { ...event, ...(trip ? { stage: 'returned' } : {}),
      ...(event.stage === 'delivered' ? { description: 'Returned to the sender' } : {}), provider_leg: 'return' };
  }
  return result;
}

/** The server-rendered tracking page, read at `readAt`. */
export function parseUSPSTrackingHtml(page: string, trackingNumber: string, readAt = Date.now()): CarrierResult {
  const number = normalizeUSPSNumber(trackingNumber);
  const $ = load(page);
  const inlineScript = $('body script:not([src])').length > 0;
  $('script, style, noscript').remove();
  if ($('.track-bar-container').length === 0) {
    const emptyBody = !clean($('body').text()) && $('body').children().length === 0;
    // A completed USPS header without the tracking application, or the
    // tracking page's head captured before its body, is not a missing
    // shipment. A second browser read can recover this partial page.
    if (/^USPS Tracking/.test($('title').text()) && ($('.Widgets_Container #g-navigation').length || emptyBody)) {
      throw new ChallengeError('USPS', 'USPS returned an incomplete tracking page', { reason: 'incomplete_page' });
    }
    // A blank, untitled page holding only the bot check's script is captured
    // before that script reloads into the tracking page. A second read passes.
    if (inlineScript && !clean($('title').text()) && emptyBody) {
      throw new ChallengeError('USPS', 'USPS returned its verification interstitial', { reason: 'interstitial_page' });
    }
    throw new ChallengeError('USPS', 'USPS challenged the browser tracking session');
  }
  const echoed = clean($('#trackingNum').first().text()).toLocaleUpperCase('en-US');
  if (echoed !== number) {
    throw new SchemaError('USPS', 'USPS did not return the requested parcel');
  }
  // The page reuses .banner-header for an upsell banner and for the headings of
  // the estimate's tooltips; only the verdict wrapper's own header is the verdict.
  const banner = clean($('.latest-update-banner-wrapper .banner-header').filter((_, header) => !$(header).closest('.speech_bubble').length)
    .first().text());
  // The estimate's heading, then its weekday, date, month and year and time in elements
  // of their own: "Expected Delivery by: Wednesday 17 March 2025 by 9:00pm".
  // Each element's text is kept apart, so "<span>March</span><br>2025" stays two words.
  const eta = $('.expected_delivery').first().clone();
  eta.find('.hint').remove();
  eta.find('*').each((_, element) => { $(element).before(' ').after(' '); });
  const estimate = clean(eta.text(), 500);
  if (/tracking not available/i.test(banner)) return notLocated();
  const current = $('.current-tracking-status-wrapper .current-step').first();
  const detail = clean(current.find('.tb-status-detail').first().text() || current.find('.tb-status').first().text(), 5_000);
  const wrapper = $('.current-tracking-status-wrapper').first();
  const statusArea = detail || clean(wrapper.text(), 5_000);
  // Without the current step's detail, an estimate is read from the wrapper's own words, not its
  // timeline: a scan's date is no estimate.
  const estimateArea = detail || clean(wrapper.clone().find('.tb-step').remove().end().text(), 5_000);
  const timeline: CarrierEvent[] = [];
  $('.current-tracking-status-wrapper .tb-step').each((_, row) => {
    const parsed = parseTimelineRow(
      clean($(row).find('.tb-status-detail').first().text(), 500),
      clean($(row).find('.tb-date').first().text(), 100),
      clean($(row).find('.tb-location').first().text(), 250),
      readAt,
    );
    if (parsed) timeline.push(parsed);
  });
  const rows: ParsedRow[] = [];
  $('.tracking_history_container tr').each((index, row) => {
    const cells = $(row).find('td').map((_, cell) => $(cell).text()).get();
    if (cells.length === 0) return;
    const parsed = parseRow(cells, index, readAt);
    if (parsed) rows.push(parsed);
  });
  rows.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  // The current timeline is newest-first. Keep its order even when some scans
  // have no resolvable timezone; sorting those behind dated scans loses meaning.
  const events = returnLeg(handoffsInTransit(timeline.length ? timeline.slice(0, MAX_EVENTS_TO_RETURN)
    : rows.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event)));
  const summary = statusArea || banner;
  const statusText = (ORIGIN_POST_NOTICE.test(summary) ? events[0]?.description : undefined) || summary
    || events[0]?.description || 'Tracking information received';
  const reported = uspsStage(`${statusText} ${banner}`)
    ?? events.map((event) => event.stage).find((value): value is NonNullable<typeof value> => value !== undefined);
  const moving = reported === 'accepted' && events.some((event) => event.stage === 'in_transit') ? 'in_transit' : reported;
  // On the trip back, the page's current step is the return under way.
  const returning = events[0]?.provider_leg === 'return' && RETURN_TRIP.has(moving ?? '');
  const stage = returning ? 'returned' : moving;
  const status = returning ? 'exception' : uspsStatus(`${statusText} ${banner}`, events.length > 0);
  const delivered = stage === 'delivered';
  return {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : returning && moving === 'delivered' ? 'Returned to the sender' : statusText,
    last_update: events[0]?.time || null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: delivered ? null
      : estimateOf(expectedDelivery(`${estimateArea} ${banner}`) ?? bannerEstimate(estimate), roundEstimate(events[0])),
    events,
  };
}

export interface USPSTrackerOptions {
  timeoutMs?: number;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  /** An HTTP(S) proxy the browser service reads through while USPS sends its own reads to the outage page. */
  fallbackProxy?: string | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class USPSTracker {
  readonly timeoutMs: number;
  readonly #trawl: TrawlClient | null;
  readonly #fallbackProxy: string | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;

  constructor(options: USPSTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('USPS timeout must be positive');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#trawl = options.trawl ?? null;
    const proxy = options.fallbackProxy?.trim() || null;
    // Checked here, so a mistyped proxy fails at setup with a message that leaves its value out.
    if (proxy) browserContextProxy(proxy);
    this.#fallbackProxy = proxy;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUSPSNumber(trackingNumber);
    // Akamai refuses every non-browser client, so a direct attempt only burns
    // time. There is one step, and it is the browser.
    const trawl = this.#trawl;
    if (!trawl) {
      throw new ChallengeError(
        'USPS',
        'USPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    // Each read's record names the route it took; a lookup paused before reading names none.
    const read: ReadRoute = { route: null, reads: 0, history: false };
    const recorder: StepRecorder = {
      step: record => this.#recorder.step(read.route ? { ...record, networkRoute: read.route,
        networkAttempt: read.reads > 1 ? 'retry' : 'initial', historyAvailable: read.history } : record),
      lookup: record => this.#recorder.lookup(record),
    };
    const run = ({ remainingMs, signal }: StepContext) => this.#trawlResult(trawl, number,
      Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal, read);
    const result = await runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'usps', budgetMs: context.budgetMs ?? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS, signal: context.signal,
      recorder,
    }, [
      { id: 'trawl', run },
      // A read straight after a redirect loads tracking more often than not, and one after two still
      // about half the time, within seconds. So a redirect on the service's own route is read again,
      // up to three reads, through its own route until three redirects in a row pause it, then
      // through the fallback proxy; a redirect through the proxy is not read again.
      { id: 'trawl', recovers: error => (error instanceof ChallengeError && RECOVERABLE_PAGES.has(error.reason ?? ''))
        || this.#readsAgain(error, read, trawl),
        run },
      // A second read stays on the interstitial about as often as a first one, so
      // a third read passes as often as the second.
      { id: 'trawl', recovers: error => (error instanceof ChallengeError && error.reason === 'interstitial_page')
        || this.#readsAgain(error, read, trawl),
        run },
    ]);
    // A typed routing barcode opens with the recipient's ZIP code. The package
    // identifier after it is the number USPS tracks, so consumers can keep that.
    return cleanUSPSNumber(trackingNumber) !== number ? { ...result, canonical_tracking_number: number } : result;
  }

  /** The fallback proxy's run while the service's own route is paused, null while it is not. */
  #fallbackRun(trawl: TrawlClient): OutageRun | null {
    return this.#fallbackProxy && pausedMs(outageRun(trawl)) > 0 ? outageRun(trawl, this.#fallbackProxy) : null;
  }

  /** Whether a read can start now through one route or the other. */
  #readable(trawl: TrawlClient): boolean {
    const fallback = this.#fallbackRun(trawl);
    return pausedMs(fallback ?? outageRun(trawl)) === 0;
  }

  /** Whether a read the service's own route sent to the outage page is read again. */
  #readsAgain(error: unknown, read: ReadRoute, trawl: TrawlClient): boolean {
    return outageRedirect(error) && read.route === 'default' && this.#readable(trawl);
  }

  /** Read the browser's rendered page without replaying its session. An
   * unresolved challenge remains an error so universal fallback can run. */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal, read: ReadRoute): Promise<CarrierResult> {
    read.route = null;
    read.history = false;
    const own = outageRun(trawl);
    const fallback = this.#fallbackRun(trawl);
    const run = fallback ?? own;
    if (pausedMs(run) > 0) {
      throw new RateLimitedError('USPS', fallback ? Math.min(pausedMs(own), pausedMs(fallback)) : pausedMs(own),
        'USPS sent the last reads to its service outage page; no read until the pause ends', { reason: 'self_paced' });
    }
    read.route = fallback ? 'residential' : 'default';
    read.reads += 1;
    const page = await trawl.scrape({
      url: uspsTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      // The verification page can become idle before it reloads into tracking.
      contentWaitForSelector: '#trackingNum',
      captureResponses: [uspsTrackingUrl(number)],
      // The service carries the whole browser context through the proxy, with no direct downgrade.
      ...(fallback ? { proxy: this.#fallbackProxy! } : {}),
    }, {
      provider: 'TRAWL while fetching USPS',
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    let result: CarrierResult;
    try { result = parseUSPSTrackingHtml(page.html, number); }
    catch (error) {
      // Prefer a complete matching page if it arrived. Only the exact tracking
      // request's observed redirect proves an outage behind a blank wrapper.
      if (error instanceof ChallengeError && page.capturedResponses.some(response =>
        response.url === uspsTrackingUrl(number) && response.trackingNumberSubmitted === number
        && response.status === 302 && response.headers.location === OUTAGE && !response.error
        && !response.truncated && !response.base64Encoded)) {
        if (++run.redirects >= OUTAGE_RUN) run.pausedUntil = Math.max(run.pausedUntil, Date.now() + OUTAGE_PAUSE_MS);
        // This lookup was redirected; it does not prove every USPS lookup is down.
        throw new IndeterminateError('USPS', 'USPS sent the lookup to its service outage page', { reason: 'maintenance_page' });
      }
      // A page that loaded, even without the parcel or with another one, ends a run of redirects.
      if (!(error instanceof ChallengeError)) run.redirects = 0;
      throw error;
    }
    run.redirects = 0;
    read.history = Boolean(result.events?.some(event => event.time || event.local_time));
    result.tracking_url = uspsTrackingUrl(number);
    result.tracking_source = 'rendered-page';
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new USPSTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    fallbackProxy: environment.env.USPS_FALLBACK_PROXY_URL,
    recorder: environment.recorder,
  });
  return {
    id: 'usps', recordsSteps: true, plannedScans: true,
    // Akamai refuses every non-browser client, so there is no direct tier.
    steps: ['trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => tracker.fetch(number, context)),
  };
};
