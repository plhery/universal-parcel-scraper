import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { relayedZtoText } from '../zto/relayed.js';
import { gjsStage, statusMap } from './status.js';

export const CARRIER = 'gjsguoji';
export const PROVIDER = 'GJS Express';
/** The lookup the tracking page at h5.guojisuyunjapan.cn asks, behind CloudFront. */
export const GJS_LOOKUP = 'https://d2dykdfpvf684s.cloudfront.net/common/getPackageTrackInfo';
/** The tracking page the site's form opens for a number. */
export const GJS_TRACKER = 'https://h5.guojisuyunjapan.cn/#/pages/public/trackDetail';
/** The clock the firm's system and its China partner write every row on. */
export const GJS_ZONE = 'Asia/Shanghai';
// A parcel's reply is some twenty kilobytes.
export const GJS_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 300;
// Letters and digits with a digit: the parcel number, with or without GJS before it, or the domestic waybill.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const PREFIX = /^GJS(?=\d)/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The service's answer for a number it holds no parcel under.
const NOT_FOUND = /^未查询到对应包裹信息$/u;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|Request blocked|aws-waf-token|awswaf|<title>\s*(?:滑动验证|验证码|安全验证|访问受限)/i;
// The firm's own rows start with the city in Latin letters: "Tokyo, Japan 快件等待揽收".
const LATIN_PLACE = /^([A-Za-z][A-Za-z .'-]{0,40},\s*[A-Za-z][A-Za-z .'-]{0,40}?)\s+(?=[^\x20-\x7E])/u;
// Or a place and its country code in brackets: "【中国国际机场,CN】 快件转运中".
const CODED_PLACE = /^【([^【】,，]{1,40})[,，]\s*[A-Z]{2}】\s*/u;
// A phone: a mobile, a landline with its area code, a hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/u;
// A courier in brackets after the role, and the phone bracket after them: "业务员[<name>][<mobile>]", "快递员[<name>]".
const PERSON = /(业务员|快递员|派件员|派送员|揽收员|揽件员|收派员|配送员)\s*\[[^[\]]{0,40}\](?:\s*\[[^[\]]{0,40}\])?/gu;
// Whoever signed, in brackets, with the comma before them: "，签收人[<name>]".
const SIGNER = /[，,]?\s*(?:签收人|代收人|收件人)\s*\[[^[\]]{0,40}\]/gu;
const BRACKETED = /[[(（][^[\]()（）]{0,60}[\])）]/gu;
// Where the courier's phone or the courtesy starts: nothing after it is the parcel's.
const TAIL = /[，,。;；\s]*(?:联系电话|请保持电话|如有|如需|感谢使用|期待再次).*$/u;
// The place in ZTO's trace sentences, in square brackets: "快件到达[南昌中转部]".
const BRACKETED_PLACE = /\[([^[\]]{1,40})\]/gu;
const NETWORK = /^中通(?:国际|快递)?$/u;
const ZTO = /中通/u;

/** A number for GJS's tracker: the parcel number, with or without GJS before it, or the domestic waybill. */
export function normalizeGjsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GJS Express numbers are eight to thirty letters and digits');
  return number;
}

/** The lookup's body: the number as `expressNo`, which the service matches against the parcel number and the domestic waybill. */
export const gjsLookupBody = (number: string): string => JSON.stringify({ packageNo: null, expressNo: number });

/** The tracking page's address for a number. */
export const gjsTrackerUrl = (number: string): string => `${GJS_TRACKER}?expressNo=${encodeURIComponent(number)}`;

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function gjsJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/u, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GJS Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GJS Express returned a reply that is not JSON', { cause });
  }
}

/**
 * A row's wording and the place it gives, without the people and phones it names. The firm's own
 * rows start with their city; ZTO's, which the firm copies once its partner has the parcel, name the
 * courier and their mobile in brackets, the signer, the pickup point and the branch's phones, and
 * end on a courtesy. ZTO's sentences that open with a city in 【】 go through ZTO's relay reader.
 */
export function gjsWording(content: string): { description: string; location?: string } {
  let text = clean(content, 2000);
  const latin = LATIN_PLACE.exec(text);
  const coded = latin ? null : CODED_PLACE.exec(text);
  let location = latin?.[1] ?? coded?.[1];
  if (latin || coded) text = text.slice((latin ?? coded)![0].length);
  else if (text.startsWith('【')) {
    const relayed = relayedZtoText(text);
    text = relayed.description;
    location = relayed.city;
  }
  text = text.replace(PERSON, '$1').replace(SIGNER, '').replace(BRACKETED, (part) => (PHONE.test(part) ? '' : part)).replace(TAIL, '');
  const phone = PHONE.exec(text);
  const description = clean(phone ? text.slice(0, phone.index) : text, 300).replace(/[\s，,；;。:：、/]+$/u, '');
  location ??= [...description.matchAll(BRACKETED_PLACE)].map((match) => match[1]!).find((place) => !NETWORK.test(place));
  const place = location ? clean(location, 80) : '';
  return { description, ...(place ? { location: place } : {}) };
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' ? normalizeTrackingNumber(clean(value, 80)) : invalid(`GJS Express returned an invalid ${key}`);
}

/** A row's wall clock; a time the calendar has not is a changed reply. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  return parsed && parsed.iso.slice(0, 19) === local ? local : invalid('GJS Express returned an invalid scan time');
}

/**
 * The parcel's rows, newest first. Each keeps its wall clock in `local_time` and is dated on China's
 * clock with `carrier` as the basis; a clock that would date a row after the read keeps its wall clock
 * alone. Rows at one clock are newest last in the reply, and a repeated row is read once.
 */
function gjsScans(rows: readonly unknown[], packageNo: string, readAt: number): CarrierEvent[] {
  if (rows.length > MAX_ROWS) return invalid('GJS Express returned an oversized history');
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || typeof row.trackingContent !== 'string') return invalid('GJS Express returned an invalid row');
    const owner = textField(row, 'packageNo');
    if (owner && owner !== packageNo) return invalid('GJS Express returned another parcel\'s row');
    const local = wallClock(row.trackingTime);
    const { description, location } = gjsWording(row.trackingContent);
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, GJS_ZONE);
    const staged = gjsStage(description);
    scans.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: GJS_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index))
    .map((scan) => scan.event);
}

/**
 * A parcel's history from the service's `{code, msg, data}` reply. Code 500 with 未查询到对应包裹信息
 * is the answer for a number it holds no parcel under; any other refusal is inconclusive. The parcel
 * number (`packageNo`, the number without GJS) or the domestic waybill (`expressNo`) must be the number
 * asked. Only the rows (`trackInfoList`) and the two numbers are read: the parcel record beside them
 * carries the recipient's and sender's names, phones, addresses and identity card, and stays behind.
 */
export function parseGjs(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeGjsNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') return invalid('GJS Express returned an invalid reply');
  if (payload.code !== 200) {
    const message = typeof payload.msg === 'string' ? clean(payload.msg, 120) : '';
    if (payload.code === 500 && NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER, 'GJS Express has no parcel under this number');
    throw new IndeterminateError(PROVIDER, 'GJS Express did not complete the lookup');
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.trackInfoList)) return invalid('GJS Express returned an invalid parcel');
  const packageNo = textField(data, 'packageNo');
  const expressNo = textField(data, 'expressNo');
  const asked = [number, number.replace(PREFIX, '')];
  if (!packageNo || ![packageNo, expressNo].some((held) => held && asked.includes(held))) {
    return invalid('GJS Express did not answer for the parcel asked');
  }
  const events = gjsScans(data.trackInfoList, packageNo, readAt);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'GJS Express lists the parcel without a row', { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  // The domestic waybill is ZTO's when it has ZTO's shape and ZTO's rows or its international line name ZTO.
  const onward = expressNo && expressNo !== number && isZtoTrackingNumber(expressNo)
    && events.some((event) => ZTO.test(event.description ?? '')) ? { delivery_carrier: 'zto', delivery_tracking_number: expressNo } : {};
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...onward,
    events,
  };
}
