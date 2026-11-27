import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ecparcelStage, statusMap } from './status.js';

export const PROVIDER = 'ecparcel';
// A shipment's scans are a few kilobytes.
export const ECPARCEL_MAX_BYTES = 512 * 1024;
/** The service the tracker page at track.ec-parcel.com asks, with the number as `trackingNumber`. */
export const ECPARCEL_LOOKUP = 'https://track.ec-parcel.com/api/shipmentTracking/getShipmentTracking';

// The service takes letters and digits only, and tells capitals from small letters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Its answer for a number it holds no shipment under. A missing route answers 404 under the same code with "Not Found".
const NOT_FOUND = 'shipment tracking not found!';
// Bot checks the Cloudflare proxy in front of the service could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
// "2026-04-30T10:09:11+10:00" at a depot, "2026-04-23T02:40:03.373Z" for the first scans: instants either way.
const CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
// "InTransit", and "InTransit_001" for a sub-status.
const STATUS = /^[A-Za-z]{2,40}$/;
const SUB_STATUS = /^[A-Za-z]{2,40}_[A-Za-z0-9]{1,10}$/;
const MAX_EVENTS = 300;

/** An ecParcel tracking number, in capitals as the service needs it. */
export function normalizeEcparcelNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ecParcel tracking numbers are letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The `errors` of a refusal: `{"success":false,"errors":[{code, message}]}`. */
function errorsOf(payload: unknown): { code: string; message: string }[] {
  if (!isRecord(payload) || payload.success !== false || !Array.isArray(payload.errors)) return [];
  return payload.errors.filter(isRecord).map((error) => ({ code: clean(error.code, 60), message: clean(error.message, 200) }));
}

/**
 * Reads one reply of the service. A 404 is a missing shipment only with the service's own words
 * for one; a 404 without them is a missing route. A 422 is the service refusing the number's form.
 */
export function parseEcparcelReply(status: number, contentType: string, body: string, raw: string): CarrierResult {
  if (REDIRECTS.has(status)) throw new TransportError(PROVIDER, 'ecParcel tracking moved', { status });
  if (!/^application\/json\b/i.test(contentType)) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ecParcel answered with a browser check');
    if (status === 404) throw new TransportError(PROVIDER, 'ecParcel tracking moved', { status });
    return invalid('ecParcel answered with a page instead of its tracking reply');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new SchemaError(PROVIDER, 'ecParcel returned a reply that is not JSON', { cause: error });
  }
  if (status === 200) return parseEcparcel(payload, raw);
  const errors = errorsOf(payload);
  if (status === 404) {
    if (errors.some((error) => error.code === 'NOT_FOUND' && error.message === NOT_FOUND)) {
      throw new NotFoundError(PROVIDER, 'ecParcel has no shipment under this number');
    }
    throw new TransportError(PROVIDER, 'ecParcel tracking moved', { status });
  }
  if (status === 422 && errors.some((error) => error.code === 'VALIDATION_ERROR')) {
    throw new InvalidInputError(PROVIDER, 'ecParcel refuses this tracking number');
  }
  return invalid('ecParcel refused the lookup');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`ecParcel returned an invalid ${key}`);
}

interface Scan { index: number; at: number; event: CarrierEvent }

/** One scan: its instant, message, place, and the status (or sub-status) it is filed under. */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) return invalid('ecParcel returned an invalid scan');
  const clock = text(row, 'eventTime', 40);
  const at = CLOCK.test(clock) ? explicitOffsetTime(clock) : null;
  if (!at) return invalid('ecParcel returned a scan without a clock with its offset');
  const description = text(row, 'eventMessage', 300);
  if (!description) return invalid('ecParcel returned a scan without its message');
  const status = text(row, 'eventStatus', 40);
  const subStatus = text(row, 'eventSubStatus', 60);
  if (!STATUS.test(status) || (subStatus && !SUB_STATUS.test(subStatus))) return invalid('ecParcel returned an invalid scan status');
  const code = subStatus || status;
  // "MOSSMAN QLD, Australia": the depot's or the delivery's suburb and state, as the page shows them.
  const location = text(row, 'location', 120) || [text(row, 'city', 80), text(row, 'state', 20)].filter(Boolean).join(' ');
  const staged = ecparcelStage(code, description);
  return { index, at: at.timestamp, event: {
    time: at.iso, description, provider_code: code, ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The reply for one shipment: `result.shipmentTrackingNumber`, the number the service looked up,
 * and `result.trackingEventList`, its scans newest first. Each scan names a status, sometimes a
 * sub-status, its message and, at a depot or the door, the suburb and state.
 */
export function parseEcparcel(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEcparcelNumber(raw);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) return invalid('ecParcel returned an invalid reply');
  const { shipmentTrackingNumber, trackingEventList } = payload.result;
  const named = typeof shipmentTrackingNumber === 'string' ? normalizeTrackingNumber(clean(shipmentTrackingNumber, 64)) : '';
  if (!named) return invalid('ecParcel returned a shipment without its number');
  if (named !== number) throw new IndeterminateError(PROVIDER, 'ecParcel answered for another shipment');
  if (!Array.isArray(trackingEventList) || trackingEventList.length > MAX_EVENTS) return invalid('ecParcel returned an invalid scan list');
  // A shipment the service names without a scan is known, with no history yet.
  if (trackingEventList.length === 0) throw new NoHistoryError(PROVIDER, 'ecParcel lists the shipment without scans', { reason: 'listed' });

  const seen = new Set<string>();
  const scans = trackingEventList.map(scanOf).filter(({ event }) => {
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  // Newest first; the reply lists the newest first, so of two scans at one instant the first is the newer.
  const events = scans.sort((a, b) => b.at - a.at || a.index - b.index).map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    ...(lead?.provider_code ? { provider_code: lead.provider_code } : {}),
    last_status_text: (lead ?? newest).description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: lead!.time! } : {}),
    events,
  };
}
