import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lerdexStage, statusMap } from './status.js';

export const PROVIDER = 'Lerdex';
export const CARRIER = 'lerdex';
// One parcel's reply is a few kilobytes.
export const LERDEX_MAX_BYTES = 256 * 1024;
// Letters, digits and letters, as the tracking page's example: five letters, ten digits and YQ.
const NUMBER = /^[A-Z]{2,8}\d{6,16}[A-Z]{0,3}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// YunExpress's own waybills, which the reply names as the line's number.
const YUNEXPRESS = /^YT\d{16}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
const MAX_ROWS = 500;
// A scan's place comes before its wording, joined by a comma without a space.
const PLACE_PREFIX = /^([^,]+(?:, [^,]+)*),(?=\S)(.+)$/;
// Four to six digits standing alone in a place are a postcode.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// Who took a delivered parcel, as a delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** A Lerdex number, without spaces or hyphens. Anything else is not a number the tracker issues. */
export function normalizeLerdexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Lerdex numbers are letters, then digits, then up to three letters');
  return number;
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function lerdexJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Lerdex answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Lerdex returned a reply that is not JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Lerdex returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock to the second. */
function wallClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'time', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Lerdex returned an invalid scan time');
  return local;
}

/**
 * A scan's place and wording. The reply leaves `location` empty and starts
 * `content` with the place, as "DELANO, MN 55328,Delivered", joined by a comma
 * without a space, where commas inside a place or a wording have one.
 */
export function lerdexWording(row: Record<string, unknown>): { description: string; location: string } {
  const content = text(row, 'content');
  const split = PLACE_PREFIX.exec(content);
  const place = text(row, 'location', 120) || (split ? split[1]! : '');
  const wording = split ? split[2]!.trim() : content;
  const description = clean(/^delivered\b/i.test(wording) ? wording.replace(RECEIVER, '') : wording, 300);
  const location = clean(place.replace(POSTCODE_RUN, '$1'), 120).replace(/^[\s,;:]+|[\s,;:]+$/g, '');
  return { description, location: /[\p{L}\p{N}]/u.test(location) ? location : '' };
}

function scans(rows: unknown[]): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Lerdex returned an invalid scan');
    const local = wallClock(row);
    const { description, location } = lerdexWording(row);
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = lerdexStage(description);
    events.push({ local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  return events;
}

/**
 * The reply of `queryOrderTracking` for one number: `code` 200 with one entry
 * per number asked. A number the tracker does not hold comes back as an entry
 * whose fields are all null. The entry's scans merge the warehouse's and the
 * line's histories, each newest first, in the wall clock of each scan's place.
 */
export function parseLerdex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLerdexNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Lerdex returned an invalid reply');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'Lerdex did not complete the lookup');
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Lerdex returned an invalid reply');
  const bound = payload.data.filter((item: unknown) => isRecord(item) && typeof item.number === 'string'
    && normalizeTrackingNumber(item.number) === number) as Record<string, unknown>[];
  if (bound.length !== 1) throw new SchemaError(PROVIDER, 'Lerdex did not answer for the parcel asked');
  const item = bound[0]!;
  const rows = item.events;
  const held = ['oriChannel', 'oriNumber', 'destCountry', 'inDate', 'status'].some((key) => item[key] !== null && item[key] !== undefined);
  if ((rows === null || rows === undefined) && !held) throw new NotFoundError(PROVIDER, 'Lerdex has no parcel under this number');
  if (!Array.isArray(rows)) {
    if (rows === null || rows === undefined) throw new NoHistoryError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Lerdex returned a parcel with invalid scans');
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Lerdex returned an oversized history');
  const events = scans(rows);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(text(item, 'destCountry', 60));
  const onward = normalizeTrackingNumber(text(item, 'oriNumber', 64));
  const line = text(item, 'oriChannel', 60);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!, last_update: null, last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(ONWARD.test(onward) && onward !== number ? { delivery_tracking_number: onward,
      ...(/^yun\s*express$/i.test(line) && YUNEXPRESS.test(onward) ? { delivery_carrier: 'yunexpress' } : {}) } : {}),
    events,
  };
}
