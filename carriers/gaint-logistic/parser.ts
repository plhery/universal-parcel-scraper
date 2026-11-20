import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gaintStage } from './status.js';

export const PROVIDER = 'Gaint Logistic';
// An order's reply is a few kilobytes of JSON; the security code's picture about six.
export const GAINT_MAX_BYTES = 256 * 1024;

// An AWB, LR or partner waybill: letters and digits, at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The tracker's answer for a number it has no shipment under.
const NOT_FOUND = /\bno shipment under that number\b/i;
const MAX_EVENTS = 300;
// The picture's characters, each a text element at its own x.
const CODE_CHARACTER = /<text\b[^>]*\bx="(\d+(?:\.\d+)?)"[^>]*>([A-Za-z0-9])<\/text>/g;
const CODE = /^[A-Z0-9]{4,8}$/;

/** A Gaint number in upper case, as the tracker reads it; anything else is not one it tracks. */
export function normalizeGaintNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Gaint numbers are six to thirty letters and digits');
  return number;
}

/**
 * The security code of the tracker's challenge: `/api/captcha` returns a token and an SVG
 * picture whose characters are text elements, which read left to right give the code.
 */
export function readGaintCode(payload: unknown): { token: string; answer: string } {
  if (!isRecord(payload) || typeof payload.token !== 'string' || !payload.token || payload.token.length > 2000
    || typeof payload.image !== 'string') {
    throw new ChallengeError(PROVIDER, 'Gaint returned an unreadable security code');
  }
  const encoded = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(payload.image)?.[1];
  const svg = encoded ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))) : '';
  const answer = [...svg.matchAll(CODE_CHARACTER)].map((match) => ({ x: Number(match[1]), character: match[2]!.toUpperCase() }))
    .sort((left, right) => left.x - right.x).map(({ character }) => character).join('');
  if (!CODE.test(answer)) throw new ChallengeError(PROVIDER, 'Gaint changed its security code');
  return { token: payload.token, answer };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Gaint returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The message of a refused lookup: an unknown number, a security code that did not match, or something else. */
export function gaintRefusal(payload: unknown, status: number): never {
  const message = isRecord(payload) ? clean(payload.message, 300) : '';
  const field = isRecord(payload) ? clean(payload.field, 40) : '';
  if (status === 404 && NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER);
  if (status === 400 && field === 'captcha') throw new ChallengeError(PROVIDER, 'Gaint did not accept its security code');
  throw new IndeterminateError(PROVIDER, 'Gaint did not complete the lookup');
}

/**
 * The tracker's reply for one order: its AWB and LR numbers, its status with whether it was
 * delivered or is returning, the courier that carries it, and its scans oldest first, each an
 * instant, a wording and a place. The order must carry the number asked, as its AWB or its LR.
 */
export function parseGaint(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGaintNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.order) || !Array.isArray(payload.events)) {
    throw new SchemaError(PROVIDER, 'Gaint returned an invalid order');
  }
  const order = payload.order;
  const numbers = [text(order, 'awbNo', 64), text(order, 'lrNo', 64)].map(normalizeTrackingNumber);
  if (!numbers.includes(number)) throw new IndeterminateError(PROVIDER, 'Gaint answered for another shipment');
  if (payload.events.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Gaint returned too many scans');
  const courier = isRecord(payload.courier) ? payload.courier : {};

  const scans: { at: number; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of payload.events.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Gaint returned an invalid scan');
    const time = explicitOffsetTime(row.eventDate);
    const description = text(row, 'statusName');
    if (!time || !description) throw new SchemaError(PROVIDER, 'Gaint returned an undated or unworded scan');
    const location = text(row, 'location', 120);
    const staged = gaintStage(description);
    scans.push({ at: time.timestamp, index, event: { time: time.iso, description, ...(location ? { location } : {}),
      ...(staged.source !== 'none' ? { stage: staged.stage, stage_source: staged.source } : {}) } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  // Newest first; scans at one instant keep the reply's order, the later first.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const status = text(order, 'status');
  const flagged = (order.isRto === true ? 'returned' : order.isDelivered === true ? 'delivered' : undefined) as Stage | undefined;
  const headed = status ? gaintStage(status) : null;
  const staged = events.find((event) => event.stage);
  // The order's flags lead, then its status, then the newest scan with a stage.
  const current: { stage: Stage; source: string } | null = flagged ? { stage: flagged, source: 'carrier_map' }
    : headed && headed.source !== 'none' ? { stage: headed.stage, source: headed.source }
      : staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const delivered = current?.stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const service = text(courier, 'name', 80);
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: status || newest.description!,
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    events,
  };
}
