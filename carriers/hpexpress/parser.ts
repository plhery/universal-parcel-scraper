import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { hpexpressStage, statusMap } from './status.js';

export const PROVIDER = 'HP Express';
export const CARRIER = 'hpexpress';
// An order's three legs come to a few kilobytes.
export const HPEXPRESS_MAX_BYTES = 1024 * 1024;
// HP and nine digits on the public samples; the page takes any order number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The legs the reply lists, each newest first: the flight from Australia, customs in China, the courier in China.
const LEGS = ['domesticTrackingInfo', 'clearanceTrackingInfo', 'internationalTrackingInfo'] as const;
const CHINA_LEGS = new Set<string>(['clearanceTrackingInfo', 'domesticTrackingInfo']);
// "转入泉州邮政快递，包裹单号为：9973555647202": the courier in China and its number, on the clearance row.
const HANDOFF = /转入\s*([^，,；;：:\s]{1,20})\s*[，,；;]?\s*(?:包裹)?单号为?\s*[:：]\s*([A-Za-z0-9]{8,30})/u;
// Couriers in China a clearance row may hand the parcel to, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/邮政|EMS/iu, 'china-post'], [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'],
];
// A clause that names a person or gives a phone: a postman, a signer, a branch's line. A number after 单号
// is the courier's waybill and stays.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|快递员|快递小哥|投递员|揽投员|揽收员|收寄员|派送员|派件员|收派员|配送员|业务员|司机|姓名|签收人|代收人|收件人|收货人|交给|(?<![A-Z\d])(?<!单号为?\s*[:：]?\s*)\d{7,}/iu;
// The first row asks for the recipient's ID card and links its upload.
const ID_CARD = /身份证|上传|点击/u;
// "他人代收：五区…": who took the parcel in, named or placed after the colon.
const SIGNED = /^(\s*[^,，;；:：]{0,12}?(?:签收|代收))\s*[:：]/u;
const BRACKETED = /[（(][^（）()]{0,200}[）)]/gu;
const PLACE = /【([^【】]{1,60})】/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

/** An order on HP Express's tracker, without spaces or hyphens. */
export function normalizeHpexpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HP Express orders are 6 to 30 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

/**
 * A row's text without the people, phones and ID-card request it carries: the link goes with its words, a
 * bracket that gives a contact goes, then every clause that names a postman, a signer or a phone, or asks for
 * the ID card. Who took a parcel in keeps the words that say so, without the name or place after them.
 * "已签收,他人代收" from a row that goes on to name the place, the postman and his mobile.
 */
export function hpexpressText(value: string): string {
  const text = value.replace(/<a\b[^>]*>[^<]{0,200}<\/a>/giu, '').replace(/<[^>]*>/gu, ' ')
    .replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  const kept: string[] = [];
  // A comma inside a bracketed place ends no clause.
  for (const clause of text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u)) {
    const signed = SIGNED.exec(clause);
    if (signed) kept.push(signed[1]!);
    else if (!CONTACT.test(clause) && !ID_CARD.test(clause)) kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/**
 * The courier in China and its number a clearance row hands the parcel to, when the row names one courier
 * whose own rules offer the number. A number alone names no one.
 */
function handoffOf(context: string, number: string): Handoff | null {
  const match = HANDOFF.exec(context);
  if (!match) return null;
  const onward = normalizeTrackingNumber(match[2]!);
  const named = COURIERS.filter(([name]) => name.test(match[1]!)).map(([, carrier]) => carrier);
  if (named.length !== 1 || onward === number || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

interface Read {
  readonly at: number;
  readonly tie: number;
  readonly event: CarrierEvent;
}

/** The order the reply gives for the whole number asked. `errorMsg` 未查到此快递单号 for it is not found. */
function orderOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !('code' in payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== 1000 || payload.success !== true) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (!Array.isArray(payload.data) || payload.data.length > 30) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  const order = (payload.data as unknown[]).find((entry) => isRecord(entry) && typeof entry.domesticTrackingNumber === 'string'
    && normalizeTrackingNumber(entry.domesticTrackingNumber) === number);
  if (!isRecord(order)) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  if (order.errorMsg !== undefined && order.errorMsg !== null && order.errorMsg !== '') {
    const message = typeof order.errorMsg === 'string' ? order.errorMsg.toUpperCase().replace(/[\s-]/gu, '') : '';
    if (message.includes(`未查到此快递单号${number}`)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  return order;
}

/**
 * HP Express's history for one order, newest first: the reply of `rpc/comm/ex/order/logisticsInfo`,
 * `{code, msg, data, success}`, with the order's three legs, each a list of rows newest first with a text and
 * `time`, epoch milliseconds. The text names the place in brackets, kept as the location. Postmen, signers,
 * phones and the ID-card upload are taken out. The courier in China a clearance row names becomes the
 * delivery carrier, with its number, when the catalog tracks that number.
 */
export function parseHpexpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHpexpressNumber(raw);
  const order = orderOf(payload, number);
  const seen = new Set<string>();
  const read: Read[] = [];
  let china = false;
  let handoff: Handoff | null = null;
  for (const [leg, field] of LEGS.entries()) {
    const rows = order[field] ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
    for (const [index, entry] of (rows as unknown[]).entries()) {
      if (!isRecord(entry) || typeof entry.context !== 'string' || entry.context.length > 4000) {
        throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
      }
      const time = epochMillisTime(entry.time);
      if (!time) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
      if (field === 'clearanceTrackingInfo') handoff ??= handoffOf(entry.context, number);
      const description = hpexpressText(entry.context);
      if (!description) continue;
      const key = JSON.stringify([time.iso, description]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (CHINA_LEGS.has(field)) china = true;
      const place = PLACE.exec(description)?.[1]?.trim();
      const staged = hpexpressStage(description);
      read.push({ at: time.timestamp, tie: (LEGS.length - leg) * (MAX_ROWS + 1) - index, event: {
        time: time.iso, ...(place && !CONTACT.test(place) ? { location: place } : {}), description,
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      } });
    }
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
    ...(china ? { destination_country: 'CN' } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
