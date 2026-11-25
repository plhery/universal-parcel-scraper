import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { barqStage } from './status.js';

export const PROVIDER = 'barq';
/** The GraphQL service BARQ's tracking page posts its `OrderTracking` query to. */
export const BARQ_LOOKUP = 'https://barqfleet.com/graphql/';
// A delivered order's reply is under 1 KB.
export const BARQ_MAX_BYTES = 256 * 1024;

/**
 * The tracking page's query, without the merchant's details and the origin's, destination's and
 * courier's coordinates, which the adapter never reads.
 */
export const BARQ_QUERY = `query OrderTracking($trackingNo: String!) {
  orderTracking(trackingNo: $trackingNo) { trackingNo orderStatus orderStatusReason }
  publicFetchOrder(trackingNo: $trackingNo) { orderLogs { status statusHumanReadable createdAt } }
}`;

// The service's answers, one for each half of the query, for a number it holds no order under.
const INVALID_NUMBER = 'Invalid Tracking Number';
const ORDER_NOT_FOUND = 'Order not found';
// Two letters and nine digits, as BARQ's help centre describes its order numbers. The service
// reads letters only in capitals.
const NUMBER = /^[A-Z]{2}\d{9}$/;
// A firewall's, CDN's or bot check's page in place of the service's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2021-11-22 16:45:25 +0300": the log's time with its offset.
const LOG_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,6})? ?([+-])(\d{2}):?(\d{2})$/;
const CODE = /^[a-z][a-z_]{1,40}$/;
const MAX_EVENTS = 200;

/** An order number for BARQ's tracker, in capitals. */
export function normalizeBarqNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BARQ order numbers are two letters and nine digits');
  return number;
}

/** Whether a reply is a block page instead of the service's JSON. */
export function isBarqBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A log's time: an instant with the offset BARQ states. */
function timeOf(value: unknown): string {
  const match = typeof value === 'string' ? LOG_TIME.exec(value.trim()) : null;
  const instant = match ? explicitOffsetTime(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`) : null;
  return instant?.iso ?? invalid('BARQ returned a log without its time');
}

/** A status code such as `picked_up`, or nothing. */
function codeOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const code = typeof value === 'string' ? value.trim() : '';
  return CODE.test(code) ? code : invalid('BARQ returned an invalid status');
}

/** One log: the status code, its wording and the time. Logs carry no place. */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('BARQ returned an invalid log');
  const code = codeOf(row.status);
  const human = typeof row.statusHumanReadable === 'string' ? clean(row.statusHumanReadable, 120) : '';
  const description = human || (code ? code.replaceAll('_', ' ') : invalid('BARQ returned a log without its status'));
  const stage = barqStage(code);
  return {
    time: timeOf(row.createdAt),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}),
  };
}

/** The GraphQL errors' messages, or a changed reply. */
function messages(errors: unknown): string[] {
  if (!Array.isArray(errors) || errors.length === 0) return invalid('BARQ returned invalid errors');
  return errors.map((error) => isRecord(error) && typeof error.message === 'string' ? clean(error.message, 200) : '');
}

/** The service's answer when it did not return an order. */
function refusal(errors: unknown): never {
  const said = messages(errors);
  // Its own answer for a number it holds no order under: the order is unknown to both halves of
  // the query. It does not repeat the number; the request for it does.
  if (said.length === 2 && said.includes(INVALID_NUMBER) && said.includes(ORDER_NOT_FOUND)) {
    throw new NotFoundError(PROVIDER, 'BARQ has no order under this number');
  }
  if (said.some((message) => /too many|rate limit|throttl/i.test(message))) throw new RateLimitedError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'BARQ did not complete the lookup');
}

/**
 * The reply to the tracking page's `OrderTracking` query: the order's number and status, and its
 * logs, newest first, each with the status code, its wording and the time with its offset. The
 * logs carry no place.
 */
export function parseBarq(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBarqNumber(raw);
  if (!isRecord(payload)) return invalid('BARQ returned an unexpected reply');
  const data = payload.data;
  if (data === null || data === undefined) return refusal(payload.errors);
  if (!isRecord(data)) return invalid('BARQ returned an unexpected reply');
  // One half answered and the other refused: the answer is not whole.
  if (payload.errors !== undefined && payload.errors !== null) return refusal(payload.errors);
  const order = data.orderTracking;
  const fetched = data.publicFetchOrder;
  if (!isRecord(order) || typeof order.trackingNo !== 'string' || !isRecord(fetched)) {
    return invalid('BARQ returned an order without its number or logs');
  }
  // The reply must name the number asked.
  if (normalizeTrackingNumber(order.trackingNo).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'BARQ answered for another order');
  }
  if (fetched.orderLogs !== null && fetched.orderLogs !== undefined && !Array.isArray(fetched.orderLogs)) {
    return invalid('BARQ returned invalid logs');
  }
  const rows = (fetched.orderLogs ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('BARQ returned too many logs');
  const events = rows.map(eventOf);
  const code = codeOf(order.orderStatus);
  if (!code) return invalid('BARQ returned an order without its status');
  const reason = typeof order.orderStatusReason === 'string' ? clean(order.orderStatusReason, 200) : '';
  const newest = events[0];
  // The order's status leads; the page shows the newest log's wording for it.
  const wording = newest?.provider_code === code ? newest.description! : code.replaceAll('_', ' ');
  const stage = barqStage(code);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' as const } : {}),
    last_status_text: reason ? `${wording}: ${reason}` : wording,
    last_update: newest?.time ?? null,
    expected_delivery: null,
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}

/** The service's reply as JSON, or the reason it is not one. */
export function barqJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isBarqBlocked(body)) throw new ChallengeError(PROVIDER, 'BARQ answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'BARQ returned a reply that is not JSON', { cause });
  }
}
