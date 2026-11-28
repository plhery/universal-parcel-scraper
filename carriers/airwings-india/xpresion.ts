import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';

/**
 * One courier's Xpresion tracking service, a courier management system whose
 * `/api/v1/Tracking/Tracking` answers the courier's public tracking page.
 */
export interface XpresionTenant {
  readonly carrier: CarrierId;
  readonly name: string;
  readonly endpoint: string;
  /** The tracking page's site, sent as the request's origin. */
  readonly origin: string;
  /** The tracking page for a number, sent as the referrer. */
  readonly page: (number: string) => string;
  /** The login the tracking page sends for every visitor. */
  readonly visitor: { readonly UserID: string; readonly Password: string };
  /** The shipment fields the page shows as the forwarding carrier's number, tracking link and name. */
  readonly forwarding: { readonly number: string; readonly link: string; readonly name: string };
  /** A scan's stage by its code and wording, or null. */
  readonly stage: (code: string, wording: string) => ClassifiedWording | null;
}

// A delivered parcel's reply is about ten kilobytes.
export const XPRESION_MAX_BYTES = 512 * 1024;
const DEFAULT_BUDGET_MS = 15_000;
// A missing or refused route is a moved lookup, never a missing parcel.
const GONE = [404, 405, 410];
// The service takes an air waybill as free text; tracking pages strip punctuation before asking.
const NUMBER = /^[A-Z0-9]{6,30}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const DAY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const CLOCK = /^\d{4}$/;
const CODE = /^[A-Za-z0-9]{1,16}$/;
// The service's answer for an air waybill it holds no shipment for ("AWB does not exist..! "), and the wording some pages wait for.
const NOT_FOUND = /^AWB (?:No )?(?:does not exist|not found)\b/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_ROWS = 500;

/** The number as the service takes it, without spaces or dashes and in capitals. */
export function xpresionNumber(tenant: XpresionTenant, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(tenant.carrier, `Invalid ${tenant.name} air waybill`);
  return number;
}

function json(tenant: XpresionTenant, body: string, httpStatus: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(tenant.carrier, `${tenant.name} answered with a browser check`, { cause });
    if (httpStatus !== 200) throw new UpstreamHttpError(tenant.carrier, httpStatus);
    throw new SchemaError(tenant.carrier, `${tenant.name} returned a reply that is not JSON`, { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(tenant: XpresionTenant, row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `EventDate` and `EventTime`, as "27/10/2026" and "1431". The reply names no zone, and a
 * forwarded parcel's rows come from the courier's offices and the delivering partner abroad, each on
 * its own clock, so the clock stays a wall clock.
 */
function scanClock(tenant: XpresionTenant, row: Record<string, unknown>): string {
  const day = text(tenant, row, 'EventDate', 16);
  const time = text(tenant, row, 'EventTime', 8);
  // Parsing in UTC checks the calendar only; the wall clock keeps no offset.
  const parsed = DAY.test(day) && CLOCK.test(time) ? DateTime.fromFormat(`${day} ${time}`, 'd/M/yyyy HHmm', { zone: 'UTC' }) : undefined;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat('HHmm') !== time) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid scan time`);
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function scan(tenant: XpresionTenant, row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid scan`);
  const description = text(tenant, row, 'Status', 400);
  if (!description) throw new SchemaError(tenant.carrier, `${tenant.name} returned a scan without a status`);
  const local = scanClock(tenant, row);
  const code = text(tenant, row, 'Excp_Code', 16);
  if (code && !CODE.test(code)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid scan code`);
  const location = text(tenant, row, 'Location', 160);
  const staged = tenant.stage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The forwarding carrier's tracking link for its number: the page puts the number in place of
 * `<PAWBNO>`, or after the link's last "=".
 */
function forwardingLink(link: string, reference: string): string {
  if (link.includes('<PAWBNO>')) return link.replace('<PAWBNO>', reference);
  const cut = link.lastIndexOf('=');
  return cut < 0 ? link : `${link.slice(0, cut + 1)}${reference}`;
}

// The partner is named when the number has its shape, or when, for a carrier without number rules,
// the page's link names that carrier for the same number.
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as string[]).includes(partner)) return true;
  if (CARRIER_DEFINITIONS[partner as CarrierId]?.detectionRules.length !== 0) return false;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/** The forwarding carrier's number, as the page shows it, and the carrier when its name or link and the number's shape agree. */
function handoff(tenant: XpresionTenant, shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(text(tenant, shipment, tenant.forwarding.number, 64));
  if (!REFERENCE.test(reference) || reference === number) return {};
  const link = forwardingLink(text(tenant, shipment, tenant.forwarding.link, 500), reference);
  const partner = carrierIdFromPartner(text(tenant, shipment, tenant.forwarding.name, 120), link);
  const named = partner && partner !== tenant.carrier && partnerShape(partner, reference, link);
  return { ...(named ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/** The destination country, when the shipment names one the catalog knows. */
function destination(tenant: XpresionTenant, shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country'> {
  const country = countryCode(text(tenant, shipment, 'Destination_Country', 80)) ?? countryCode(text(tenant, shipment, 'Destination', 80));
  return country ? { destination_country: country } : {};
}

/**
 * The reply of `POST /api/v1/Tracking/Tracking` on a tenant's Xpresion host, the lookup its tracking
 * page makes: `ErrorDisc` "Success" lists the shipment in `Tracking` and its scans in `Events`; an
 * unknown number gets "AWB does not exist" with no shipment. The shipment must be the number asked.
 * Its shipper, consignee and receiver names, reference, weight, delivery summary and
 * proof-of-delivery flag are not read.
 */
export function parseXpresion(tenant: XpresionTenant, body: string, raw: string, httpStatus: number): CarrierResult {
  const number = xpresionNumber(tenant, raw);
  const reply = json(tenant, body, httpStatus);
  if (httpStatus !== 200) throw new UpstreamHttpError(tenant.carrier, httpStatus);
  const response = isRecord(reply) ? reply.Response : undefined;
  if (!isRecord(response)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid envelope`);
  const message = text(tenant, response, 'ErrorDisc', 160);
  if (message !== 'Success') {
    if (NOT_FOUND.test(message)) throw new NotFoundError(tenant.carrier);
    throw new IndeterminateError(tenant.carrier, `${tenant.name} refused the lookup: ${message || clean(response.ResponseCode, 16) || 'no message'}`);
  }
  if (!Array.isArray(response.Tracking)) throw new SchemaError(tenant.carrier, `${tenant.name} returned an invalid envelope`);
  const shipment = (response.Tracking as unknown[]).find((entry): entry is Record<string, unknown> => isRecord(entry)
    && normalizeTrackingNumber(text(tenant, entry, 'AWBNo', 64)) === number);
  if (!shipment) throw new IndeterminateError(tenant.carrier, `${tenant.name} answered for another shipment`);
  const rows = response.Events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(tenant.carrier, `${tenant.name} returned invalid scans`);
  const partner = handoff(tenant, shipment, number);
  if (!rows.length) {
    throw new NoHistoryError(tenant.carrier, undefined, { reason: 'listed', deliveryCarrier: partner.delivery_carrier,
      deliveryTrackingNumber: partner.delivery_tracking_number });
  }

  const scans: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { key, event } = scan(tenant, row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(event);
  }
  // Newest first by wall clock; scans of the same minute keep the reply's order, newest first.
  if (listsNewestFirst(scans) === false) scans.reverse();
  const clock = (event: CarrierEvent) => event.local_time as string;
  const events = scans.sort((left, right) => (clock(left) === clock(right) ? 0 : clock(left) < clock(right) ? 1 : -1));

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    ...(newest.provider_code ? { provider_code: newest.provider_code } : {}),
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...destination(tenant, shipment),
    ...partner,
    ...(stage === 'delivered' ? {} : unreadEstimates({ 'Tracking.ExpectedDeliveryDate': shipment.ExpectedDeliveryDate })),
    events,
  };
}

/** The adapter of one Xpresion tenant: one lookup by air waybill, bound to the number asked. */
export const xpresionAdapter = (tenant: XpresionTenant): AdapterFactory => (environment) => ({
  id: tenant.carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = xpresionNumber(tenant, input.number);
    return runSteps({ carrier: tenant.carrier, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // `Type` A asks by air waybill, as the page does unless the visitor picks a reference.
      const { response, bytes } = await fetchBounded(tenant.endpoint, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json',
        Origin: tenant.origin, Referer: tenant.page(number), 'User-Agent': userAgentOf(environment.userAgent),
      }, body: JSON.stringify({ ...tenant.visitor, AWBNo: number, Type: 'A', RequiredUrl: 'yes' }) }, {
        provider: tenant.carrier, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: XPRESION_MAX_BYTES,
        fetcher: environment.fetcher, allowHttpStatuses: GONE,
      }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (GONE.includes(response.status)) throw new TransportError(tenant.carrier, `${tenant.name} tracking lookup is unavailable`, { status: response.status });
      return parseXpresion(tenant, decodeText(bytes), number, response.status);
    } }]);
  },
});
