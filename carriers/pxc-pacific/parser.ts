import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pxcStage } from './status.js';

export const PROVIDER = 'pxc-pacific';
// A delivered parcel's reply is about ten kilobytes.
export const PXC_MAX_BYTES = 512 * 1024;

// The tracker takes an air waybill as free text; the page strips punctuation before asking.
const NUMBER = /^[A-Z0-9]{6,30}$/;
const DAY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const CLOCK = /^\d{4}$/;
const CODE = /^[A-Za-z0-9]{1,16}$/;
// The lookup's answer for an air waybill it holds no shipment for, and the wording the page itself waits for.
const NOT_FOUND = /^AWB (?:No )?(?:does not exist|not found)\b/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_ROWS = 500;

/** The number as the tracker takes it, without spaces or dashes and in capitals. */
export function normalizePxcNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid PXC Pacific Global air waybill');
  return number;
}

export function isChallengePage(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

function json(body: string, httpStatus: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isChallengePage(body)) throw new ChallengeError(PROVIDER, 'PXC Pacific Global answered with a browser check', { cause });
    if (httpStatus !== 200) throw new UpstreamHttpError(PROVIDER, httpStatus);
    throw new SchemaError(PROVIDER, 'PXC Pacific Global returned a reply that is not JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PXC Pacific Global returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `EventDate` and `EventTime`, as "27/10/2026" and "1431". The reply names no zone,
 * and its rows come from PXC's offices, its transit points and the delivering partner abroad,
 * each on its own clock, so the clock stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const day = text(row, 'EventDate', 16);
  const time = text(row, 'EventTime', 8);
  // Parsing in UTC checks the calendar only; the wall clock keeps no offset.
  const parsed = DAY.test(day) && CLOCK.test(time)
    ? DateTime.fromFormat(`${day} ${time}`, 'd/M/yyyy HHmm', { zone: 'UTC' }) : undefined;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat('HHmm') !== time) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function scan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned an invalid scan');
  const description = text(row, 'Status', 400);
  if (!description) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned a scan without a status');
  const local = scanClock(row);
  const code = text(row, 'Excp_Code', 16);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned an invalid scan code');
  const location = text(row, 'Location', 160);
  const staged = pxcStage(code, description);
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
 * The delivering partner's number, as the page's "Tracking Number" shows it, and the partner
 * when its name, or the tracking link the page opens for that number, is a catalog carrier.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(text(shipment, 'VendorAWBNo2', 64));
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  // The page puts the number in place of `<PAWBNO>` in the partner's link.
  const link = text(shipment, 'VendorLinkURL1', 500).replace('<PAWBNO>', reference);
  const partner = carrierIdFromPartner(text(shipment, 'VendorName2', 120), link);
  return {
    ...(partner && partner !== PROVIDER && partner !== 'unknown' ? { delivery_carrier: partner } : {}),
    delivery_tracking_number: reference,
  };
}

function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = text(shipment, 'Destination_Country', 80) || text(shipment, 'Destination', 80);
  const code = name ? countryCode(name) : undefined;
  return code ? { destination_country: code } : name ? { destination_country_name: name } : {};
}

/**
 * The reply of `POST /api/v1/Tracking/Tracking` on eship.pacificexp.net, the lookup PXC's
 * tracking page makes for each number in its `awbno` parameter. `ErrorDisc` "Success" lists the
 * shipment in `Tracking` and its scans newest first in `Events`: PXC's own steps in Mumbai and at
 * its gateways and transit points, with the delivering partner's scans among them. An unknown
 * number gets "AWB does not exist" with no shipment. The shipment must be the number asked. Its
 * shipper, consignee and receiver names, reference, weight and proof-of-delivery flags are not read.
 */
export function parsePxc(body: string, number: string, httpStatus: number): CarrierResult {
  const reply = json(body, httpStatus);
  if (httpStatus !== 200) throw new UpstreamHttpError(PROVIDER, httpStatus);
  const response = isRecord(reply) ? reply.Response : undefined;
  if (!isRecord(response)) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned an invalid envelope');
  const message = text(response, 'ErrorDisc', 160);
  if (message !== 'Success') {
    if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, `PXC Pacific Global refused the lookup: ${message || clean(response.ResponseCode, 16) || 'no message'}`);
  }
  if (!Array.isArray(response.Tracking)) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned an invalid envelope');
  const shipment = (response.Tracking as unknown[]).find((entry) => isRecord(entry)
    && normalizeTrackingNumber(text(entry, 'AWBNo', 64)) === number);
  if (!isRecord(shipment)) throw new IndeterminateError(PROVIDER, 'PXC Pacific Global answered for another shipment');
  const rows = response.Events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PXC Pacific Global returned invalid scans');
  const partner = handoff(shipment, number);
  if (!rows.length) {
    throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed', deliveryCarrier: partner.delivery_carrier,
      deliveryTrackingNumber: partner.delivery_tracking_number });
  }

  const scans: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { key, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(event);
  }
  // Newest first by wall clock, as the page lists them; scans of the same minute keep the reply's order.
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
    ...destination(shipment),
    ...partner,
    events,
  };
}
