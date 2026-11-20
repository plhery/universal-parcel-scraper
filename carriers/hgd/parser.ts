import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { itdidaCountry } from '../whwdt/itdida.js';
import { hgdStage, statusMap } from './status.js';

export const PROVIDER = 'HGD';
export const CARRIER = 'hgd';
// One parcel's record is a kilobyte or two.
export const HGD_MAX_BYTES = 256 * 1024;
// The clock the forwarder's own rows are written on, in Shenzhen.
const ZONE = 'Asia/Shanghai';
// HGD, the line's letters, digits and a closing pair, as the samples' HGDGY, ten digits and YQ.
const NUMBER = /^HGD[A-Z]{0,4}\d{8,14}[A-Z]{0,3}$/;
// The record's first line: 100 for a waybill found, -102 for a number the tracker holds nothing under.
const FOUND = '100';
const UNKNOWN = '-102';
const RETURN = /^\s*(-?\d{1,5})\s*(?:\r?\n|$)/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/;
const ROW = /<DATETIME>([^<]*)<\/DATETIME>\s*<PLACE>([^<]*)<\/PLACE>\s*<INFO>([^<]*)<\/INFO>/g;
const WEIGHT = /^\d{1,4}(?:\.\d{1,3})?$/;
const MAX_ROWS = 500;

/** An HGD waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeHgdNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HGD waybills are HGD, letters and digits');
  return number;
}

/** The one element of a tag in a block, or nothing; a repeated one is a changed reply. */
function field(block: string, tag: string, maxLength = 120): string {
  const matches = [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))];
  if (matches.length > 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a repeated ${tag}`);
  return matches.length ? textFromHtml(matches[0]![1], maxLength) : '';
}

/** The one block a tag encloses; none, or several, is a changed reply. */
function block(body: string, tag: string): string {
  const matches = [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  if (matches.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a record without one ${tag}`);
  return matches[0]![1]!;
}

/** A row's wall clock, to the minute or the second as the row gives it. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}${match[3] ? `:${match[3]}` : ''}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat(match[3] ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  return local;
}

/**
 * A parcel's scans, newest first. The tracker lists them oldest first, each a
 * wall clock without its zone. A row dated after the lookup on the
 * forwarder's clock is not a scan yet and is left out. A row without wording
 * says nothing, and a repeated one is read once.
 */
function scans(rows: string, readAt: number): CarrierEvent[] {
  const seen = new Set<string>();
  const read: { local: string; event: CarrierEvent }[] = [];
  const matches = [...rows.matchAll(ROW)];
  // Rows the pattern did not read are a changed reply.
  if (rows.replace(ROW, '').trim()) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
  if (matches.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  for (const [, clock, place, info] of matches) {
    const local = wallClock(textFromHtml(clock, 40));
    if (firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toMillis() > readAt) continue;
    const description = textFromHtml(info, 300);
    if (!description) continue;
    const location = textFromHtml(place, 120);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = hgdStage(description);
    read.push({ local, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // Newest first: the tracker's order reversed, then by clock, which keeps equal clocks in that order.
  return read.reverse().sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : 0)).map((scan) => scan.event);
}

/**
 * The record HGD's tracker returns for one number: a return code on the first
 * line, then the waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`.
 * `-102` is the answer for a number the tracker holds nothing under. The
 * waybill must be the whole number asked. The sender's address and the
 * forwarder's inner number are never kept.
 */
export function parseHgd(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHgdNumber(raw);
  const code = RETURN.exec(body)?.[1];
  if (!code) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  }
  if (code === UNKNOWN) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  if (code !== FOUND) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  const info = block(body, 'EMS_INFO');
  if (normalizeTrackingNumber(field(info, 'TRCKING_NBR', 64)) !== number) {
    throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  }
  const events = scans(block(body, 'TRACK_DATA'), readAt);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = itdidaCountry(field(info, 'DES', 60));
  const weight = field(info, 'WEIGHT', 16);
  const kilograms = WEIGHT.test(weight) && Number(weight) > 0 ? Number(weight) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(kilograms !== null ? { weight_kg: kilograms } : {}),
    events,
  };
}
