import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { blitzStage } from './status.js';

export const PROVIDER = 'Blitz';
export const BLITZ_MAX_BYTES = 256_000;
/** The lookup the tracking page on `track.blitznow.in` posts the number to. */
export const BLITZ_URL = 'https://track-api.blitznow.in/whitelisttrack/api/track/';
export const BLITZ_ORIGIN = 'https://track.blitznow.in';
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required|403 Forbidden)|_cf_chl_opt|captcha|access denied|request rejected/i;
/** The reply to a number the service does not know, an HTTP 500 that names the failed shipment lookup. */
const UNKNOWN = /^internal server error ?: ?failure due to bad request from logistic'?s get shipment details api$/i;
const MAX_SCANS = 200;
/** Statuses after which the tracker shows the day it happened instead of the delivery estimate. */
const FINAL = new Set(['cancelled', 'rto delivered', 'delivered', 'lost', 'damaged']);

/** The tracker opens a parcel by a segment of letters and digits that holds a digit. */
export function normalizeBlitzNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

export const blitzRequest = (number: string) => ({ field: 'shipment', value: number });

const text = (value: unknown, max = 80) => (typeof value === 'string' ? clean(value, max) : '');
const unreadable = (what: string) => new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable ${what}`);

/** The shipment of a reply that found one. */
export function blitzPayload(body: string, httpStatus: number): Record<string, unknown> {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a verification page`, { cause });
    if (httpStatus >= 400) throw new UpstreamHttpError(PROVIDER, httpStatus);
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with a page instead of its tracking JSON`, { cause });
  }
  if (!isRecord(reply)) throw unreadable('reply');
  const message = text(reply.status, 200);
  if (httpStatus === 200 && reply.code === '200') {
    if (!isRecord(reply.result)) throw unreadable('shipment');
    return reply.result;
  }
  if (httpStatus === 500 && reply.code === '501' && UNKNOWN.test(message)) throw new NotFoundError(PROVIDER);
  if (httpStatus >= 400) throw new UpstreamHttpError(PROVIDER, httpStatus);
  throw new IndeterminateError(PROVIDER, `${PROVIDER} refused the lookup: ${message || 'no reason given'}`);
}

/** An instant with the offset the service states; a clock without one is unreadable. */
function instant(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isInteger(value) && value > 1e12 && value < 1e13) {
    return new Date(value).toISOString().replace('.000Z', 'Z');
  }
  const stamp = typeof value === 'string' ? value : '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(stamp);
  if (!match) throw unreadable(what);
  const offset = match[2] === 'Z' ? 0 : (match[3] === '-' ? -1 : 1) * (Number(match[4]) * 60 + Number(match[5]));
  const at = Date.parse(`${match[1]}${match[2]}`);
  if (Number.isNaN(at) || Math.abs(offset) > 14 * 60 || new Date(at + offset * 60_000).toISOString().slice(0, 19) !== match[1]) throw unreadable(what);
  return `${match[1]}${match[2]}`;
}

const optionalInstant = (value: unknown, what: string) => (value == null || value === '' ? null : instant(value, what));

function readableEstimate(value: unknown): string | null {
  try {
    return typeof value === 'string' ? optionalInstant(value, 'delivery estimate') : null;
  } catch {
    return null;
  }
}

function staged(status: string): { stage: Stage; source: string } | null {
  const mapped = blitzStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(status, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

interface Scan { index: number; at: number; event: CarrierEvent & { time: string; description: string } }

/** The scans the tracker lists under its steps, when the reply carries them. */
function scans(details: unknown): Scan[] {
  const partner = Array.isArray(details) && isRecord(details[0]) ? details[0] : {};
  const rows = partner.tracking;
  if (rows == null) return [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw unreadable('history');
  return rows.map((row, index) => {
    if (!isRecord(row)) throw unreadable('scan');
    const status = text(row.shipmentStatus);
    if (!status) throw unreadable('scan');
    const time = instant(row.timestamp, 'scan time');
    const classified = staged(status);
    // A scan's remarks are the rider's free text; they are not kept.
    return { index, at: Date.parse(time), event: {
      time, description: status, ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    } };
  });
}

/** The parcel's status, and its scans when the reply lists them, for the number asked. */
export function parseBlitz(result: Record<string, unknown>, rawNumber: string): CarrierResult {
  const number = normalizeBlitzNumber(rawNumber);
  const details = result.shipmentDetails;
  if (!isRecord(details)) throw unreadable('shipment');
  const answered = text(details.awbnumber, 60).replace(/[\s-]+/g, '').toUpperCase();
  if (!answered) throw unreadable('shipment');
  // The tracker looks a parcel up by other references too; only its own number names it.
  if (answered !== number) throw new IndeterminateError(PROVIDER, `${PROVIDER} answered with another shipment`);
  const status = text(details.shipmentstatus);
  if (!status) throw unreadable('status');
  const classified = staged(status);
  const stage = classified?.stage;
  const changed = optionalInstant(details.modifieddate, 'status time');
  const list = scans(result.trackingDetails);
  list.sort((left, right) => right.at - left.at || left.index - right.index);
  const newest = list[0]?.event.time;
  const lastUpdate = newest && (!changed || Date.parse(newest) >= Date.parse(changed)) ? newest : changed;
  // The tracker shows the day of a final status from the shipment's last change.
  const deliveredScan = list.find(scan => scan.event.stage === 'delivered')?.event.time;
  const final = FINAL.has(status.toLowerCase().replace(/\s+/g, ' '));
  // The page shows the buyer's estimate until then; an estimate without its offset is left out.
  const estimate = final ? null : readableEstimate(details.buyerEDD);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(classified ? { current_stage: stage, current_stage_source: classified.source } : {}),
    last_status_text: status,
    last_update: lastUpdate,
    expected_delivery: estimate ? estimate.slice(0, 10) : null,
    ...(stage === 'delivered' ? { delivered_at: deliveredScan ?? changed } : {}),
    ...(list.length ? {} : { summary_only: true }),
    events: list.map(scan => scan.event),
  };
}
