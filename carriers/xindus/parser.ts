import { DateTime, IANAZone } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { xindusMappedStage, xindusStage } from './status.js';

export const PROVIDER = 'xindus';
export const XINDUS_MAX_BYTES = 1024 * 1024;

const NUMBER = /^[A-Z0-9]{4,40}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The tracker's answer for a number it holds no shipment for: HTTP 500 with this description.
const UNKNOWN_AWB = /^Invalid Data - Cannot Perform Operation - Please provide valid AWB$/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_BOXES = 200;
const MAX_ROWS = 2_000;

/** The number as the tracker takes it: an air waybill such as X and nine digits. */
export function normalizeXindusNumber(raw: string): string {
  return normalizeTrackingNumber(raw);
}

export function isXindusNumber(number: string): boolean {
  return NUMBER.test(number);
}

function json(body: string, httpStatus: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Xindus answered with a browser check', { cause });
    if (httpStatus !== 200) throw new UpstreamHttpError(PROVIDER, httpStatus);
    throw new SchemaError(PROVIDER, 'Xindus returned a reply that is not JSON', { cause });
  }
}

/**
 * A scan's instant: the wall clock in `date` read in the zone Xindus states beside it in
 * `timezone`. A clock the zone repeats when its clocks go back reads as its first occurrence.
 */
function scanTime(row: Record<string, unknown>): string {
  const wall = WALL_CLOCK.exec(clean(row.date, 32));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  if (!wall || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Xindus returned an invalid scan time');
  }
  const zone = clean(row.timezone, 64);
  if (!zone || !IANAZone.isValidZone(zone)) throw new SchemaError(PROVIDER, 'Xindus returned a scan without its zone');
  const time = firstOccurrence(DateTime.fromISO(local, { zone })).toISO({ suppressMilliseconds: true });
  if (!time) throw new SchemaError(PROVIDER, 'Xindus returned an invalid scan time');
  return time;
}

function scan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Xindus returned an invalid scan');
  const code = clean(row.status, 80).toUpperCase();
  const label = clean(row.status_name, 120);
  const description = clean(row.description, 300) || label;
  if (!/^[A-Z0-9_]+$/.test(code) || !description) throw new SchemaError(PROVIDER, 'Xindus returned a scan without a status');
  const time = scanTime(row);
  const location = clean(row.node, 160);
  const staged = xindusStage(code, label || description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clean(row.date, 32), clean(row.timezone, 64), code, description, location]), event };
}

/**
 * The carrier that delivers a box in the destination country and its number there, when the
 * box names both, the catalog knows the carrier by that name and link, and its rules offer
 * that number.
 */
function handoff(boxes: Record<string, unknown>[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (boxes.length !== 1) return {};
  const box = boxes[0]!;
  const name = clean(box.lm_carrier, 80);
  const number = normalizeTrackingNumber(clean(box.lm_tracking_number, 64));
  if (!name || !/^[A-Z0-9]{4,40}$/.test(number)) return {};
  const carrier = carrierIdFromPartner(name, clean(box.tracking_url, 500));
  if (!carrier || carrier === PROVIDER || !(detectCarrierMatch(number).candidates as string[]).includes(carrier)) return {};
  return { delivery_carrier: carrier, delivery_tracking_number: number };
}

/**
 * The reply of `shipment-tracking/shipment?scancode={number}`, the lookup Xindus's tracking page
 * makes. A known shipment is HTTP 200 with one entry in `data`: the shipment's status, and its
 * boxes, each with the carrier that delivers it in the destination country and its scans. A
 * number Xindus has no shipment for is HTTP 500 with a description asking for a valid AWB; the
 * page also reads an empty `data` as not found.
 */
export function parseXindus(body: string, number: string, httpStatus: number): CarrierResult {
  const reply = json(body, httpStatus);
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'Xindus returned an invalid envelope');
  if (httpStatus !== 200) {
    if (reply.error_status === true && UNKNOWN_AWB.test(clean(reply.error_description, 200))) throw new NotFoundError(PROVIDER);
    throw new UpstreamHttpError(PROVIDER, httpStatus);
  }
  if (reply.error_status !== false || !Array.isArray(reply.data)) throw new SchemaError(PROVIDER, 'Xindus returned an invalid envelope');
  if (!reply.data.length) throw new NotFoundError(PROVIDER);
  const shipment = (reply.data as unknown[]).find((entry) => isRecord(entry) && normalizeTrackingNumber(clean(entry.scancode, 64)) === number);
  if (!isRecord(shipment)) throw new IndeterminateError(PROVIDER, 'Xindus answered for another shipment');
  const boxes = shipment.boxes_tracking ?? [];
  if (!Array.isArray(boxes) || boxes.length > MAX_BOXES || !boxes.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Xindus returned invalid boxes');
  }

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const box of boxes as Record<string, unknown>[]) {
    const rows = box.tracking_event ?? [];
    if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Xindus returned invalid scans');
    for (const row of rows) {
      const { key, event } = scan(row);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
      if (events.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Xindus returned too many scans');
    }
  }
  // Newest first; scans at the same instant keep Xindus's order, which lists the newest first.
  const ordered = events.map((event, index) => ({ event, index, at: Date.parse(event.time!) }))
    .sort((left, right) => right.at - left.at || left.index - right.index)
    .map(({ event }) => event);

  const code = clean(shipment.status, 80).toUpperCase();
  const newest = ordered[0];
  const listed = code ? xindusMappedStage(code) : undefined;
  const stage: Stage | undefined = listed ?? (newest?.stage as Stage | undefined);
  const source = listed ? 'carrier_map' : newest?.stage_source;
  const text = clean(shipment.status_description, 300) || clean(shipment.status_name, 120) || newest?.description;
  if (!newest && !stage) throw new IndeterminateError(PROVIDER, 'Xindus returned neither a status nor scans');
  const delivered = stage === 'delivered' ? ordered.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    ...(text ? { last_status_text: text } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(newest?.time ? { last_update: newest.time } : {}),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...handoff(boxes),
    ...(newest ? {} : { summary_only: true }),
    events: ordered,
  };
}
