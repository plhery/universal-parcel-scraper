/**
 * DispatchTrack's guest order tracker, shared by the delivery firms that track
 * their orders on it: High Energy Transport and Ryder Last Mile. Each firm is a
 * tenant with a track code its tracking links carry; its folder declares a
 * `DispatchTrackTenant`. The lookups, their replies and the snapshot's stage
 * codes (`./status.ts`) are DispatchTrack's.
 */
import { DateTime, IANAZone } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate, type WindowEstimate } from '../../core/result/window.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dispatchTrackStage } from './status.js';

// A snapshot is a few kilobytes; the order widget's reply carries the page's
// template and every grouped order, some tens of kilobytes each.
export const DISPATCHTRACK_MAX_BYTES = 2 * 1024 * 1024;
// The firms number their orders their own way, and track their shippers'
// references too: letters and digits.
const ORDER = /^[A-Z0-9]{3,40}$/;
// "Tuesday 4th, June 2024".
const ETA_DAY = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+([A-Za-z]+)\s+(\d{4})$/;
// "10:00 AM - 01:00 PM", a window on that day.
const ETA_WINDOW = /^(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i;
const NOT_FOUND = 'Order not found';
const WIDGET_NOT_FOUND = 'No orders found';
const MAX_ORDERS = 50;
const MAX_EVENTS = 100;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|Request blocked/i;

/** One firm on DispatchTrack's tracker. Neither firm's tracker asks for the delivery ZIP code. */
export interface DispatchTrackTenant {
  readonly carrier: string;
  readonly provider: string;
  /** The firm's subdomain of dispatchtrack.com. */
  readonly tenant: string;
  /** The firm's track code, which its tracking links carry before the order number. */
  readonly trackCode: string;
  /**
   * Whether the order widget is read beside the snapshot for its events. A
   * firm that writes a dated event at each milestone sets it; the widget is
   * read for any firm when the snapshot labels the order with another number.
   */
  readonly history: boolean;
  /** An event's stage by the firm's own wording; the shared wording rules otherwise. */
  readonly eventStage?: (wording: string) => ClassifiedWording | null;
}

/** The order number as the tracker takes it: letters and digits. Anything else is invalid input. */
export function dispatchTrackNumber(tenant: DispatchTrackTenant, raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!ORDER.test(number)) throw new InvalidInputError(tenant.provider, `${tenant.provider} order numbers are letters and digits`);
  return number;
}

const origin = (tenant: DispatchTrackTenant) => `https://${tenant.tenant}.dispatchtrack.com`;

/** The lookup the tracker page's frame asks, with the order number where its script puts it. */
export function dispatchTrackSnapshotUrl(tenant: DispatchTrackTenant, raw: string): string {
  const params = new URLSearchParams({ phone_number: dispatchTrackNumber(tenant, raw) });
  return `${origin(tenant)}/api/v1/order_tracker/${tenant.trackCode}?${params}`;
}

/** The order widget's lookup, which the older tracker page asks. */
export function dispatchTrackWidgetUrl(tenant: DispatchTrackTenant, raw: string): string {
  return `${origin(tenant)}/track_orders/${tenant.trackCode}/${encodeURIComponent(dispatchTrackNumber(tenant, raw))}`;
}

/** An optional text field; anything but a string is a changed reply. */
function text(provider: string, row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** What the snapshot says about one order. */
export interface DispatchTrackSnapshot {
  /** The order the snapshot is for, as the tracker labels it. */
  readonly order: string;
  readonly code: string;
  /** The status the tracker shows. */
  readonly wording: string;
  readonly estimate: WindowEstimate;
}

/** The day of a stated date, kept only when its weekday agrees. */
function etaDay(label: string): string | null {
  const parts = ETA_DAY.exec(label);
  if (!parts) return null;
  // A calendar date: parsing in UTC reads its digits only.
  const day = DateTime.fromFormat(`${parts[2]} ${parts[3]} ${parts[4]}`, 'd LLLL yyyy', { zone: 'UTC', locale: 'en-US' });
  return day.isValid && day.toFormat('cccc', { locale: 'en-US' }).toLowerCase() === parts[1]!.toLowerCase() ? day.toISODate() : null;
}

/**
 * The delivery window: a date and the window's two clocks on it, in the zone
 * the reply states, which the tracker turns into the visitor's own. Without a
 * zone it stays that day's slot on its wall clock; without a window, the day.
 */
function estimate(provider: string, value: unknown): WindowEstimate {
  if (value === null || value === undefined) return { expected_delivery: null };
  if (!isRecord(value)) throw new SchemaError(provider, `${provider} returned an invalid delivery window`);
  const day = etaDay(text(provider, value, 'dateLabel', 80));
  if (!day) return { expected_delivery: null };
  const window = ETA_WINDOW.exec(text(provider, value, 'etaLabel', 80));
  const zone = text(provider, value, 'timeZone', 64);
  if (!window || (zone && !IANAZone.isValidZone(zone))) return { expected_delivery: day };
  const clock = (end: string) => zonedTime(`${day} ${end.replace(/\s+/g, '').toUpperCase()}`, 'yyyy-MM-dd hh:mma', zone || 'UTC', { locale: 'en-US' });
  const [from, to] = [clock(window[1]!), clock(window[2]!)];
  if (!from || !to) return { expected_delivery: day };
  return zone ? windowEstimate(from.iso, to.iso) : windowEstimate(from.iso.slice(0, 16), to.iso.slice(0, 16));
}

/**
 * The tracker's snapshot of one order, which must be the tenant's. Only its
 * label, stage code, status and delivery window are read: the recipient, the
 * drop address and its map position, the items, the driver and the live
 * channel are not kept. `details.delivery.promisedWindow` has been seen
 * holding a time unrelated to the delivery, so it is not read either.
 */
export function readDispatchTrackSnapshot(tenant: DispatchTrackTenant, payload: unknown): DispatchTrackSnapshot {
  const { provider } = tenant;
  if (!isRecord(payload) || payload.type !== 'order.snapshot') throw new SchemaError(provider, `${provider} returned an invalid order snapshot`);
  if (payload.tenantId !== tenant.tenant || payload.orderId !== tenant.trackCode) {
    throw new SchemaError(provider, `${provider} returned another firm's order snapshot`);
  }
  const order = normalizeTrackingNumber(text(provider, payload, 'shortLabel', 80));
  const code = text(provider, payload, 'stage', 40);
  if (!order || !code) throw new SchemaError(provider, `${provider} returned an order snapshot without its order or stage`);
  return {
    order, code,
    wording: text(provider, payload, 'displayStatus', 120) || text(provider, payload, 'statusLabel', 120),
    estimate: estimate(provider, payload.eta),
  };
}

/** Whether the order widget is asked too: for its events, or for the number the snapshot does not name. */
export function dispatchTrackReadsWidget(tenant: DispatchTrackTenant, payload: unknown, raw: string): boolean {
  return tenant.history || readDispatchTrackSnapshot(tenant, payload).order !== dispatchTrackNumber(tenant, raw);
}

function wordingStage(wording: string): ClassifiedWording | null {
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

interface Dated { event: CarrierEvent; at: number; index: number }

/** One event: its time, an instant with its offset, its place and its wording. */
function projectEvent(tenant: DispatchTrackTenant, row: unknown, index: number): Dated {
  const { provider } = tenant;
  if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid order event`);
  const at = explicitOffsetTime(row.event_datetime);
  const description = text(provider, row, 'event_description');
  if (!at || !description) throw new SchemaError(provider, `${provider} returned an order event without its time or wording`);
  const location = text(provider, row, 'event_location', 120);
  const staged = (tenant.eventStage ?? wordingStage)(description);
  return {
    event: {
      time: at.iso, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    at: at.timestamp, index,
  };
}

/**
 * The events of the snapshot's order in the order widget's reply, newest
 * first. The widget finds orders by DispatchTrack's own order number, the
 * firm's reference or its tracking number: the order must be the one the
 * snapshot labels, and one of its numbers the whole number asked. Its
 * recipient, address, phones, driver, truck and items are not read.
 */
export function readDispatchTrackWidget(tenant: DispatchTrackTenant, payload: unknown, raw: string, order: string): CarrierEvent[] {
  const { provider } = tenant;
  const number = dispatchTrackNumber(tenant, raw);
  if (!isRecord(payload)) throw new SchemaError(provider, `${provider} returned an invalid order widget`);
  if (payload.success === false) {
    // The snapshot holds the order, so the widget's own not-found answer contradicts it.
    if (isRecord(payload.error) && payload.error.message === WIDGET_NOT_FOUND) {
      throw new IndeterminateError(provider, `${provider}'s order widget does not find the order its tracker shows`);
    }
    throw new SchemaError(provider, `${provider} returned an order widget error`);
  }
  if (payload.success !== true || !isRecord(payload.business) || payload.business.track_code !== tenant.trackCode
    || !Array.isArray(payload.service_orders) || payload.service_orders.length > MAX_ORDERS) {
    throw new SchemaError(provider, `${provider} returned an invalid order widget`);
  }
  const numbers = (row: Record<string, unknown>) => ['service_order_number', 'reference_number', 'tracking_number']
    .map((key) => normalizeTrackingNumber(text(provider, row, key, 80))).filter(Boolean);
  const orders: unknown[] = payload.service_orders;
  const match = orders.find((row) => isRecord(row)
    && normalizeTrackingNumber(text(provider, row, 'service_order_number', 80)) === order);
  if (!isRecord(match)) throw new IndeterminateError(provider, `${provider}'s order widget answered for another order`);
  if (!numbers(match).includes(number)) throw new IndeterminateError(provider, `${provider} answered for another order`);
  const rows = match.order_ship_events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS * 5) throw new SchemaError(provider, `${provider} returned invalid order events`);
  return rows.map((row, index) => projectEvent(tenant, row, index))
    // Newest first; of two events at one instant, the earlier in the reply is newer, as the widget lists them.
    .sort((left, right) => right.at - left.at || left.index - right.index)
    .map((dated) => dated.event);
}

/**
 * The snapshot's order, with the order widget's events when it was read. The
 * snapshot's stage is the current state, but a scheduled order's newest staged
 * event can be further along. Without events the result is a summary. A
 * delivered order keeps no estimate.
 */
export function parseDispatchTrack(tenant: DispatchTrackTenant, snapshot: unknown, raw: string, widget?: unknown): CarrierResult {
  const { provider } = tenant;
  const number = dispatchTrackNumber(tenant, raw);
  const read = readDispatchTrackSnapshot(tenant, snapshot);
  const all = widget === undefined ? null : readDispatchTrackWidget(tenant, widget, number, read.order);
  if (!all && read.order !== number) throw new IndeterminateError(provider, `${provider} answered for another order`);
  const events = (all ?? []).slice(0, MAX_EVENTS);
  const coded = dispatchTrackStage(read.code);
  const staged = events.find((event) => event.stage);
  const decided: ClassifiedWording | null = coded && (coded.stage !== 'registered' || !staged) ? coded
    : staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const stage = decided?.stage;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: read.wording || events[0]?.description || null,
    provider_code: read.code,
    last_update: events[0]?.time ?? null,
    ...(stage === 'delivered' ? { expected_delivery: null } : read.estimate),
    ...(delivery ? { delivered_at: delivery.time } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
    ...(all && all.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

function json(provider: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/** A tenant's tracker: the snapshot, then the order widget when the tenant or the snapshot calls for it. */
export class DispatchTrackTracker {
  constructor(private readonly tenant: DispatchTrackTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { tenant } = this;
    const { provider } = tenant;
    const number = dispatchTrackNumber(tenant, raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const get = async (url: string): Promise<{ status: number; payload: unknown }> => {
        const { response, bytes } = await fetchBounded(url, { signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: DISPATCHTRACK_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 422] });
        if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`, { status: response.status });
        const payload = json(provider, decodeText(bytes));
        if (response.status === 422) {
          // The tracker's reCAPTCHA check, which its page shows as an access error.
          if (isRecord(payload) && payload.captcha_error) throw new ChallengeError(provider, `${provider} asks for its reCAPTCHA check`);
          throw new TransportError(provider, `${provider} refused the tracking lookup`, { status: 422 });
        }
        return { status: response.status, payload };
      };
      const snapshot = await get(dispatchTrackSnapshotUrl(tenant, number));
      if (snapshot.status === 404) {
        if (isRecord(snapshot.payload) && snapshot.payload.error === NOT_FOUND) throw new NotFoundError(provider);
        throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: 404 });
      }
      if (!dispatchTrackReadsWidget(tenant, snapshot.payload, number)) return parseDispatchTrack(tenant, snapshot.payload, number);
      signal.throwIfAborted();
      const widget = await get(dispatchTrackWidgetUrl(tenant, number));
      if (widget.status === 404) throw new TransportError(provider, `${provider} order widget is unavailable`, { status: 404 });
      return parseDispatchTrack(tenant, snapshot.payload, number, widget.payload);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** A tenant's adapter: the snapshot and, when called for, the order widget, with one retry after a network failure. */
export function dispatchTrackAdapter(tenant: DispatchTrackTenant): AdapterFactory {
  return (environment) => {
    const tracker = new DispatchTrackTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: tenant.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
    };
  };
}
