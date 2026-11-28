import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { flowlinkText } from '../jdxexpress/flowlink.js';
import { morelinkStage, statusMap, statusWord } from './status.js';

export const PROVIDER = 'MoreLink';
export const CARRIER = 'morelink56';
// An order's reply is a few kilobytes.
export const MORELINK_MAX_BYTES = 512 * 1024;
// Letters and digits with a digit: the firm's SO numbers are fifteen digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
// "2020-03-05 15:18", "2020-03-06 14:45:01" and "2020-03-17 14:42:02.923", wall clocks.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$/;
const MISSING = /^抱歉！未查到此运单\s*([A-Za-z0-9-]{1,64}?)\s*信息/u;
// The answers for a code that does not match the picture, and for a session that holds no code.
const REFUSED = new Set(['验证码不正确', '验证码过期']);
// A status word that has the goods leave China, and one that has them at the destination.
const DEPARTED = /开船|起飞|离港/u;
const ARRIVED = /到港|目的港/u;
// A place a remark names: "货物已抵达【深圳福永仓】".
const PLACE = /【([^【】]{2,30})】/u;
// Destinations by the Chinese name `addr` starts with, before the warehouse's code ("日本FSZ1").
const COUNTRIES: readonly (readonly [string, string])[] = [
  ['日本', 'JP'], ['美国', 'US'], ['加拿大', 'CA'], ['英国', 'GB'], ['德国', 'DE'], ['法国', 'FR'], ['意大利', 'IT'],
  ['西班牙', 'ES'], ['荷兰', 'NL'], ['比利时', 'BE'], ['波兰', 'PL'], ['捷克', 'CZ'], ['瑞典', 'SE'], ['澳大利亚', 'AU'],
  ['墨西哥', 'MX'], ['阿联酋', 'AE'], ['沙特', 'SA'], ['新加坡', 'SG'],
];
const MAX_ROWS = 300;

interface Row {
  readonly sono?: unknown;
  readonly addr?: unknown;
  readonly title?: unknown;
  readonly routedate?: unknown;
}

/** An order number on the firm's tracker, without spaces or hyphens. */
export function normalizeMorelinkNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'MoreLink order numbers are 6 to 30 letters and digits');
  return number;
}

/** The reply's message when it refuses the verify code or has none for the session, else null. */
export function morelinkRefusedCode(reply: unknown): string | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const { success, msg } = reply as { success?: unknown; msg?: unknown };
  return success === false && typeof msg === 'string' && REFUSED.has(clean(msg, 40)) ? clean(msg, 40) : null;
}

function wallClock(value: unknown): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

function rowsOf(reply: unknown): readonly Row[] {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const { success, msg, data } = reply as { success?: unknown; msg?: unknown; data?: unknown };
  if (success !== true) {
    if (typeof msg === 'string' && REFUSED.has(clean(msg, 40))) throw new SchemaError(PROVIDER, `${PROVIDER} answered with a refused verify code`);
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with an unknown message`);
  }
  let groups: unknown;
  try { groups = typeof data === 'string' ? JSON.parse(data) : null; } catch { groups = null; }
  if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray((groups[0] as { tb?: unknown } | null)?.tb)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  }
  const rows = (groups[0] as { tb: unknown[] }).tb;
  if (!rows.length || rows.length > MAX_ROWS || !rows.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  }
  return rows as Row[];
}

/**
 * The firm's history for one order, newest first, from the JSON its search answers: `data` is a JSON string of one
 * group whose rows each echo the order (`sono`) and give the destination (`addr`), a status word with a remark
 * (`title`) and a wall clock (`routedate`). 抱歉！未查到此运单<number>信息 for the number asked is the tracker's
 * only answer for an order it does not know. Rows up to the vessel's or flight's departure are on China's clock;
 * from the arrival on, a row keeps its wall clock unless it names a place in a destination with one clock. The
 * proof of delivery links (`podfile`, `picture`) are never read.
 */
export function parseMorelink(reply: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeMorelinkNumber(raw);
  if (typeof reply === 'object' && reply !== null && (reply as { success?: unknown }).success === false) {
    const missing = MISSING.exec(clean((reply as { msg?: unknown }).msg, 300));
    if (missing) {
      if (normalizeTrackingNumber(missing[1]!) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    }
  }
  const rows = rowsOf(reply);
  if (!rows.every((row) => typeof row.sono === 'string' && normalizeTrackingNumber(row.sono) === number)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const destination = COUNTRIES.find(([name]) => clean(rows[0]!.addr, 100).startsWith(name));
  const destinationZone = destination ? countryTimeZone(destination[1]) : null;
  // Oldest first, by the clocks; the reply lists the newest first.
  const dated = rows.map((row, index) => ({ row, index, local: wallClock(row.routedate) }))
    .sort((a, b) => a.local.localeCompare(b.local) || b.index - a.index);
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  let abroad = false;
  for (const { row, local } of dated) {
    if (typeof row.title !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
    // A remark may name people and phones; a stray quote often ends the title.
    const description = flowlinkText(row.title.replace(/[\s']+$/u, ''));
    const word = statusWord(description);
    if (ARRIVED.test(word)) abroad = true;
    const location = PLACE.exec(description)?.[1];
    // Abroad, only a place in a destination with one clock dates a row.
    const zone = !abroad ? ZONE : location && destinationZone && location.startsWith(destination![0]) ? destinationZone : null;
    if (DEPARTED.test(word)) abroad = true;
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = zone ? firstOccurrence(DateTime.fromISO(local, { zone })) : null;
    const staged = morelinkStage(description);
    read.push({
      ...(zone && instant!.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant!.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: zone === ZONE ? 'carrier' : 'place' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  const events = read.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(destination ? { destination_country: destination[1] } : {}),
    events,
  };
}

/** Whether a body is a browser check a CDN or a cloud firewall put in place of the tracker's JSON. */
export function isChallenge(body: string): boolean {
  return /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i
    .test(body.slice(0, 64_000));
}
