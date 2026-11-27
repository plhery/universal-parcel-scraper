import { detectCarrierMatch, isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { statusMap, ttkEuropeJourneyStep, ttkEuropeStage } from './status.js';

export const PROVIDER = 'ttk-europe';
// One parcel's reply is a few kilobytes.
export const TTK_EUROPE_MAX_BYTES = 256 * 1024;
const NUMBER = /^TE\d{9}GB$/;
// The service's answer for a number it has no parcel under, and for a request without a number.
const NOT_FOUND = '单号不存在';
const NO_NUMBER = '请提交要查询的单号';
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const MAX_ROWS = 200;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// Han characters and the full-width punctuation around them, as 【】 and ，.
const HAN = '\\u2e80-\\u2fdf\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
// What follows the last of them.
const AFTER_CHINESE = new RegExp(`[${HAN}]([^${HAN}]*)$`, 'u');
// A staff member named in brackets after their role, as the depot's receipt names who took the
// parcel in: "【伯明翰仓】的收件员【…】已收件".
const STAFF = /(收件员|揽收员|揽件员|取件员|派件员|派送员|配送员|快递员|司机|操作员|签收人)\s*[:：]?\s*【[^【】]{0,40}】/g;
const LONDON = 'Europe/London';
const BEIJING = 'Asia/Shanghai';
/** The domestic carrier the record's `classify` names, by the catalog's id: 邮政 is China Post. */
const PARTNERS: Readonly<Record<string, CarrierId>> = { youzheng: 'china-post' };

/** A TTK Europe number: TE, nine digits with the S10 check digit, and GB, in capitals. */
export function normalizeTtkEuropeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'TTK Europe numbers are TE, nine digits with their check digit, and GB');
  }
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function text(value: unknown, max: number): string {
  if (value !== undefined && value !== null && typeof value !== 'string') return invalid('TTK Europe returned an invalid tracking field');
  if (typeof value === 'string' && value.length > max) return invalid('TTK Europe returned an oversized tracking field');
  return clean(value, max);
}

/** "2023-01-16 12:37:00", with or without its seconds, as a wall clock. */
function clockOf(value: unknown): string {
  const parts = CLOCK.exec(text(value, 32));
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2000 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    return invalid('TTK Europe returned an unreadable scan clock');
  }
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/**
 * The English half of a row TTK Europe words in Chinese, then English: "【英国】订单生成TE…GB
 * Shipment Created" is "Shipment Created". Null when the row has no English after its Chinese.
 */
export function ttkEuropeEnglishHalf(wording: string): string | null {
  const tail = AFTER_CHINESE.exec(wording)?.[1];
  if (tail === undefined) return null;
  // A reference written against the Chinese, as the order's number, belongs to that half.
  const english = (/^\s/.test(tail) ? tail : tail.replace(/^\S+/, '')).trim();
  return /^[A-Z][A-Za-z]/.test(english) ? english : null;
}

/**
 * A row's clock. TTK Europe states no zone, and its rows mix the United Kingdom's clock with
 * China's: a row placed in China (the airport, customs, China Post) is read on Beijing's, and one
 * placed in the United Kingdom (its depots, the processing centre, Heathrow) on London's. A row
 * without a place keeps its wall clock alone, for the consumer to date by its neighbours.
 */
function clockAt(local: string, place: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const zone = place.startsWith('中国') ? BEIJING : place.startsWith('英国') || place.endsWith('仓') ? LONDON : null;
  const time = zone ? isoTime(local, zone)?.iso : undefined;
  return time ? { local_time: local, time, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

interface Scan { event: CarrierEvent; local: string; step: number | undefined; index: number }

function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) return invalid('TTK Europe returned an invalid scan');
  const local = clockOf(row.op_time);
  const wording = text(row.op_desc, 500).replace(STAFF, '$1').replace(/\s+/g, ' ').trim();
  if (!wording) return invalid('TTK Europe returned a scan without wording');
  const place = clean(/【([^【】]{1,60})】/.exec(wording)?.[1], 60);
  const description = ttkEuropeEnglishHalf(wording) ?? wording;
  const staged = ttkEuropeStage(description);
  return { local, index, step: ttkEuropeJourneyStep(description), event: {
    ...clockAt(local, place), description, ...(place ? { location: place } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * Newest first by the clocks as written, as the reply lists them. Rows written at the same
 * minute come in either order, customs' release before or after the hand-over to China Post,
 * so those the map knows follow the journey.
 */
const newestFirst = (left: Scan, right: Scan): number => (left.local < right.local ? 1 : left.local > right.local ? -1 : 0)
  || (left.step !== undefined && right.step !== undefined ? right.step - left.step : 0) || left.index - right.index;

/**
 * The carrier that delivers in China and its number, when the record names a carrier the
 * catalog knows by `classify` and that carrier's own rule claims the whole related number.
 */
function handoff(record: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const partner = PARTNERS[text(record.classify, 40).toLowerCase()];
  const reference = normalizeTrackingNumber(cleanScalar(record.related_mail, 64) || cleanScalar(record.mail_num, 64)).toUpperCase();
  if (!partner || !/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const match = detectCarrierMatch(reference);
  return match.confidence === 'high' && match.carrier === partner ? { delivery_carrier: partner, delivery_tracking_number: reference } : {};
}

/**
 * The reply of `GET /api/open/tracking/?mail_num=` for one number, which the tracking page on
 * ttkeu.com makes. It finds a record by TTK Europe's number or by the related domestic number,
 * whatever its case; the record must name the number asked as `mail_no`. A number without a
 * record is `单号不存在` with no data.
 */
export function parseTtkEurope(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTtkEuropeNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.errno !== 'number') {
    return invalid('TTK Europe returned an invalid envelope');
  }
  const message = text(payload.msg, 200);
  if (payload.errno !== 0) throw new IndeterminateError(PROVIDER, 'TTK Europe did not complete the lookup');
  if (payload.data.length === 0) {
    if (message === NOT_FOUND) throw new NotFoundError(PROVIDER, 'TTK Europe has no parcel under this number');
    // The service read no number from the request, which carried one: the request changed.
    if (message === NO_NUMBER) return invalid('TTK Europe read no number from the lookup');
    throw new IndeterminateError(PROVIDER, 'TTK Europe returned no record');
  }
  if (payload.data.length > 20 || !payload.data.every(isRecord)) return invalid('TTK Europe returned invalid records');
  const records = payload.data.filter((record) => normalizeTrackingNumber(text(record.mail_no, 64)).toUpperCase() === number);
  if (records.length === 0) throw new IndeterminateError(PROVIDER, 'TTK Europe answered for another number');
  if (records.length > 1) return invalid('TTK Europe returned several records for one number');
  const record = records[0]!;
  const rows = record.tracking ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('TTK Europe returned an invalid history');
  const partner = handoff(record, number);
  if (!rows.length) {
    throw new NoHistoryError(PROVIDER, 'TTK Europe has the parcel without a scan', { reason: 'listed',
      deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number });
  }
  const events = rows.map(scanOf).sort(newestFirst).map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    expected_delivery: null,
    ...partner,
    events,
  };
}

/** One reply of the service: its JSON, a verification page, or a changed service. */
export function parseTtkEuropeReply(body: string, raw: string): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TTK Europe answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'TTK Europe answered with a page instead of its tracking JSON', { cause });
  }
  return parseTtkEurope(payload, raw);
}
