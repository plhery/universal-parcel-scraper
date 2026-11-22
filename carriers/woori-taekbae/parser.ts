import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap, wooriStage } from './status.js';

export const PROVIDER = 'woori-taekbae';
// A reply is a few kilobytes: one shipment and its scans.
export const WOORI_MAX_BYTES = 256 * 1024;

// The tracking page asks for ten to fourteen digits, without hyphens.
const NUMBER = /^\d{10,14}$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
// The reply's fields for a number the tracker does not know, and nothing else.
const NOT_FOUND_KEYS = ['MSG_ID', 'ODS0', 'ODS0_TOTAL'];
// The reply's code for an answer, found or not.
const ANSWERED = '0000';
// yyyyMMddHHmmss: a wall clock without a zone.
const CLOCK = /^(\d{4})(\d{2})(\d{2})([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/;
const CODE = /^[0-9A-Za-z]{1,8}$/;
// A run of nine or more digits, with hyphens, dots, spaces or brackets between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
// A place that names a person: a masked name or a driver (기사).
const PERSON = /[*＊]|기사/;
const MAX_ROWS = 300;

type Row = Record<string, unknown>;

/** A Woori Taekbae waybill: ten to fourteen digits, as its tracking page asks for them. */
export function normalizeWooriNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Woori Taekbae waybills are ten to fourteen digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string is a changed reply. */
function text(row: Row, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return invalid(`Woori Taekbae returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock, `yyyyMMddHHmmss` on Seoul's wall clock without an offset, kept as that wall
 * time; text that does not read as one, or names a day the calendar lacks, stays as written.
 */
export function wooriClock(value: string): { local_time?: string; provider_time_text?: string } {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) return value ? { provider_time_text: value } : {};
  return { local_time: `${day}T${match[4]}:${match[5]}:${match[6]}` };
}

/** A scan's branch or terminal, without phone numbers; a place that names a person is dropped. */
function place(value: string): string {
  const name = clean(value.replace(PHONE, ' ').replace(/\(\s*\)/g, ' '), 80);
  return !name || PERSON.test(name) ? '' : name;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Woori Taekbae answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Woori Taekbae returned a reply that is not JSON', { cause });
  }
}

/**
 * The scans of the shipment the reply names for the number asked: the not-found reply, a reply
 * for another number or a shipment without scans end here.
 */
function scansOf(payload: unknown, number: string): readonly unknown[] {
  if (!isRecord(payload) || typeof payload.MSG_ID !== 'string') return invalid('Woori Taekbae returned an invalid envelope');
  if (payload.MSG_ID !== ANSWERED) throw new IndeterminateError(PROVIDER, 'Woori Taekbae answered with an error');
  const total = payload.ODS0_TOTAL;
  const shipments = payload.ODS0;
  if (!Number.isInteger(total) || !Array.isArray(shipments) || shipments.length !== total) {
    return invalid('Woori Taekbae returned an answer without its shipments');
  }
  if (total === 0) {
    // The page's only answer for a number it does not know, which does not repeat the number.
    if (Object.keys(payload).sort().join() !== NOT_FOUND_KEYS.join()) return invalid('Woori Taekbae returned a changed empty answer');
    throw new NotFoundError(PROVIDER, 'Woori Taekbae has no shipment under this waybill');
  }
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Woori Taekbae named several shipments under one waybill');
  const shipment: unknown = shipments[0];
  if (!isRecord(shipment)) return invalid('Woori Taekbae returned an invalid shipment');
  const echoed = text(shipment, 'SLIP_BARCD', 64);
  if (!echoed) return invalid('Woori Taekbae returned a shipment without its waybill');
  if (normalizeTrackingNumber(echoed) !== number) throw new IndeterminateError(PROVIDER, 'Woori Taekbae answered for another waybill');
  const rows = shipment.TRACKING_DTL;
  if (!Array.isArray(rows)) return invalid('Woori Taekbae returned a shipment without its scans');
  if (rows.length > MAX_ROWS) return invalid('Woori Taekbae returned too many scans');
  // The tracker names the shipment and lists no scan: none yet, or none kept.
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, 'Woori Taekbae lists the shipment without a scan', { reason: 'listed' });
  return rows;
}

/** The scans, newest first, each with its step name, code, clock and branch. */
function eventsOf(rows: readonly unknown[]): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return invalid('Woori Taekbae returned an invalid scan');
    const description = text(row, 'SCANGB_NM', 120);
    if (!description) return invalid('Woori Taekbae returned a scan without its step');
    const code = text(row, 'SCANGB', 16);
    if (code && !CODE.test(code)) return invalid('Woori Taekbae returned an invalid scan code');
    const when = wooriClock(text(row, 'SCAN_DM', 40));
    // The branch or terminal; the scan's user, which the page shows as its place, can be a person.
    const location = place(text(row, 'SCAN_AGY_NM', 120));
    const key = JSON.stringify([when.local_time ?? when.provider_time_text ?? '', code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = wooriStage(description);
    events.push({
      ...when, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  // The reply lists scans oldest first. Reversed, then sorted stably by clock: scans of one second
  // keep the reply's order, and a scan without a clock stays under the scan above it.
  let above = '9999-12-31T23:59:59';
  const keyed = events.reverse().map((event) => {
    above = event.local_time ?? above;
    return { event, key: above };
  });
  return keyed.sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : 0)).map(({ event }) => event);
}

/**
 * Reads the reply of `www.honamlogis.co.kr/tracking_number.php`, the lookup Woori Taekbae's
 * tracking page makes: JSON served as HTML. `MSG_ID` `0000` with no shipment is the page's
 * answer for a number it does not know; another `MSG_ID` is an error. A shipment names its
 * waybill in `SLIP_BARCD`, with its scans oldest first. The sender's and recipient's names,
 * phones and address, the branches' phones, the goods, the price and the scan's user are never
 * read.
 */
export function parseWoori(body: string, raw: string): CarrierResult {
  const number = normalizeWooriNumber(raw);
  const events = eventsOf(scansOf(json(body), number));

  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events.find((event) => event.local_time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    expected_delivery: null,
    events,
  };
}
