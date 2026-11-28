import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { bmxpsStage, statusMap } from './status.js';

export const PROVIDER = 'BMXPS';
export const CARRIER = 'bmxps';
// An order's rows come to a few kilobytes.
export const BMXPS_MAX_BYTES = 512 * 1024;
// BM and ten digits on the public sample; the page takes any order number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "/Date(1645641508000)/": ASP.NET's epoch milliseconds, an instant.
const DOTNET_DATE = /^\/Date\((\d{10,14})\)\/$/;
// "已转【顺丰速递】派送，运单号 SF…": the courier in China and its waybill.
const HANDOFF = /已?转\s*【([^【】]{1,20})】\s*派送\s*[，,；;]?\s*运单号\s*[:：]?\s*([A-Za-z0-9]{8,30})/u;
// Couriers in China a hand-off row may name, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/邮政|EMS/iu, 'china-post'],
];
// A clause that names a person or gives a phone: a courier, a signer, a hotline. A number after 运单号 is a
// waybill and stays.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|快递员|快递小哥|投递员|派送员|派件员|收派员|配送员|业务员|司机|姓名|签收人|代收人|收件人|收货人|交给|(?<![A-Z\d])(?<!运单号\s*[:：]?\s*)\d{7,}/iu;
// SF's pointer to the signature picture and the signer on its own site, a second after the delivery: no scan.
const SIGNER_NOTICE = /签收图|签收人信息/u;
// "已签收(本人签收)": who took the parcel in stays inside the delivery row's own words.
const SIGNED = /^(\s*[^,，;；:：]{0,12}?(?:签收|代收))\s*[:：]/u;
const BRACKETED = /[（(][^（）()]{0,200}[）)]/gu;
const PLACE = /【([^【】]{1,60})】/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** An order on BMXPS's tracker, without spaces or hyphens. */
export function normalizeBmxpsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BMXPS orders are 6 to 30 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

/**
 * A row's text without the people and phones it names: a bracket that gives a contact goes, then every clause
 * that names a courier, a signer or a phone. Who took a parcel in keeps the words that say so.
 */
export function bmxpsText(value: string): string {
  const text = value.replace(/<[^>]*>/gu, ' ').replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  const kept: string[] = [];
  // A comma inside a bracketed place ends no clause.
  for (const clause of text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u)) {
    const signed = SIGNED.exec(clause);
    if (signed) kept.push(signed[1]!);
    else if (!CONTACT.test(clause)) kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/**
 * The courier in China and its waybill a hand-off row names, when the row names one courier whose own rules
 * offer the number. A number alone names no one.
 */
function handoffOf(message: string, number: string): Handoff | null {
  const match = HANDOFF.exec(message);
  if (!match) return null;
  const onward = normalizeTrackingNumber(match[2]!);
  const named = COURIERS.filter(([name]) => name.test(match[1]!)).map(([, carrier]) => carrier);
  if (named.length !== 1 || onward === number || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

/**
 * The rows of the reply. `{"result":false,"message":"订单不存在","data":null}` is the tracker's answer for an
 * order it does not know; any other refusal is inconclusive. The reply does not repeat the number.
 */
function rowsOf(payload: unknown): unknown[] {
  if (!isRecord(payload) || typeof payload.result !== 'boolean') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (!payload.result) {
    if (typeof payload.message === 'string' && payload.message.trim() === '订单不存在' && payload.data == null) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    }
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (!Array.isArray(payload.data) || payload.data.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  return payload.data as unknown[];
}

interface Read {
  readonly at: number;
  readonly tie: number;
  readonly event: CarrierEvent;
}

/**
 * BMXPS's history for one order, newest first: the reply of `Home/Tracking`, `{result, message, data}`, with
 * the order's rows oldest first, each a `Message` and an `EventTime` in epoch milliseconds, so every row is an
 * instant. The warehouse rows name the Baltimore warehouse in brackets and SF Express's relayed rows its
 * branches; the first bracket is kept as the location, except on the hand-off row, whose bracket names the
 * courier. Couriers, signers and phones are taken out. The courier in China a hand-off row names becomes the
 * delivery carrier, with its waybill, when that courier's rules offer the number.
 */
export function parseBmxps(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBmxpsNumber(raw);
  const rows = rowsOf(payload);
  const seen = new Set<string>();
  const read: Read[] = [];
  let china = false;
  let handoff: Handoff | null = null;
  for (const [index, entry] of rows.entries()) {
    if (!isRecord(entry) || typeof entry.Message !== 'string' || entry.Message.length > 4000 || typeof entry.EventTime !== 'string') {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    const millis = DOTNET_DATE.exec(entry.EventTime.trim())?.[1];
    const time = millis ? epochMillisTime(millis) : null;
    if (!time) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
    if (SIGNER_NOTICE.test(entry.Message)) continue;
    const named = handoffOf(entry.Message, number);
    handoff = named ?? handoff;
    const description = bmxpsText(entry.Message);
    if (!description) continue;
    const key = JSON.stringify([time.iso, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (/中国|清关|顺丰/u.test(description)) china = true;
    const place = HANDOFF.test(description) ? undefined : PLACE.exec(description)?.[1]?.trim();
    const staged = bmxpsStage(description);
    read.push({ at: time.timestamp, tie: index, event: {
      time: time.iso, ...(place && !CONTACT.test(place) ? { location: place } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  const events = read.sort((left, right) => right.at - left.at || right.tie - left.tie).map((entry) => entry.event);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(china || handoff ? { destination_country: 'CN' } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
