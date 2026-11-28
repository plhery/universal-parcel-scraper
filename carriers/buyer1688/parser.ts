import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { buyer1688Stage, statusMap } from './status.js';

export const PROVIDER = '1688 International Logistics';
export const CARRIER = 'buyer1688';
// A parcel's reply is a few kilobytes.
export const BUYER1688_MAX_BYTES = 256 * 1024;
// The box takes the platform's parcel number: letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const TORONTO = 'America/Toronto';
const CHINA = 'Asia/Shanghai';
// "2025-03-24 19:14:49.0": the wall clock the platform writes, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/;
// The first row in China: the arrival there, the port of entry, customs.
const IN_CHINA = /到达国内|到达中国|口岸|清关|转关|海关|入境/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;
// A phone: a mobile, a landline with its area code, a hotline.
const PHONE = /(?<![\dA-Z-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\dA-Z-])/iu;
// Words that name a person or ask the reader to call.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|客服|快递员|配送员|派送员|派送人|派件员|派件人|收派员|揽收员|揽件员|小哥|司机|签收人[:：]/u;

/** A parcel number on the platform's tracker, without spaces or hyphens. */
export function normalizeBuyer1688Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '1688 International Logistics numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the JSON. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/**
 * A row's text, which the page writes as HTML, up to its first clause that gives a phone or a contact: the
 * platform's own rows have none, and a row a courier in China wrote may name its courier.
 */
export function buyer1688Text(raw: string): string {
  const kept: string[] = [];
  for (const clause of textFromHtml(raw, 2000).split(/(?<=[，,。；;！!])/u)) {
    if (PHONE.test(clause) || CONTACT.test(clause)) break;
    kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/[\s,，;；:：。、]+$/u, '');
}

function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
  return value;
}

/** JD Logistics under the waybill `exressno1` gives, when JD Logistics' rules take it. */
function jdHandoff(payload: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const onward = typeof payload.exressno1 === 'string' && payload.exressno1.length <= 64 ? normalizeTrackingNumber(payload.exressno1) : '';
  if (!onward || onward === number || !(detectCarrierMatch(onward).candidates as string[]).includes('jd-logistics')) return {};
  return { delivery_carrier: 'jd-logistics', delivery_tracking_number: onward };
}

/**
 * The platform's history for one parcel, newest first, from `check_post.htm`'s reply: `{flag, packid, exressno1,
 * list: {Traces}}` with `packid` the number asked, `exressno1` the JD Logistics waybill in China (the number asked
 * again when there is none) and the rows oldest first, each a wall clock without a zone and a text. `flag` 1 with
 * no rows is the platform's only answer for a number it holds nothing under, and the same as for a parcel whose
 * rows have gone. The rows at the Toronto warehouse and on the way out are on Toronto's clock; from the first row
 * of the arrival in China, the port or customs on, they are on China's. A zone that would date a row after the
 * lookup leaves it its wall clock alone.
 */
export function parseBuyer1688(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeBuyer1688Number(raw);
  const reply = body.replace(/^\uFEFF/, '').trim();
  let payload: unknown;
  try {
    payload = JSON.parse(reply);
  } catch {
    if (isChallenge(reply)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
  }
  if (!isRecord(payload) || !('flag' in payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  // The page shows nothing for any other flag.
  if (String(payload.flag).trim() !== '1') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (typeof payload.packid !== 'string' || payload.packid.length > 64 || normalizeTrackingNumber(payload.packid) !== number) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const traces = isRecord(payload.list) ? payload.list.Traces : undefined;
  if (!Array.isArray(traces) || traces.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  if (!traces.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  const rows = (traces as unknown[]).map((entry) => {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    return { local: wallClock(entry.AcceptTime), text: text(entry.AcceptStation, 2000), location: clean(text(entry.Location, 200), 60) };
  });
  const arrival = rows.findIndex((row) => IN_CHINA.test(row.text));
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const description = buyer1688Text(row.text);
    if (!description) continue;
    const key = JSON.stringify([row.local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const china = arrival >= 0 && index >= arrival;
    const zone = china ? CHINA : TORONTO;
    const instant = firstOccurrence(DateTime.fromISO(row.local, { zone }));
    const staged = buyer1688Stage(description);
    read.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: china ? 'destination' : 'carrier' } : {}),
      local_time: row.local, ...(row.location ? { location: row.location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // The platform lists the rows in the order they happened, across both clocks; that order stands.
  const events = read.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const handoff = jdHandoff(payload, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(arrival >= 0 || handoff.delivery_carrier ? { destination_country: 'CN' } : {}),
    ...handoff,
    events,
  };
}
