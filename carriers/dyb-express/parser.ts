import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { dybStage, statusMap } from './status.js';

export const PROVIDER = 'DYB Express';
export const CARRIER = 'dyb-express';
// A waybill's page is some twenty kilobytes, most of it the site's template.
export const DYB_MAX_BYTES = 512 * 1024;
/** The clock the tracking page says its rows are on (北京时间). */
export const DYB_ZONE = 'Asia/Shanghai';

// Letters and digits with a digit: DYB's waybills, S and twelve digits or DYB and thirteen on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A label of the result and the value of the read-only field after it.
const FIELD = /<label class="layui-form-label">([^<]{1,40})<\/label>\s*<div class="layui-input-inline">\s*<input\b[^>]*\bvalue="([^"]{0,80})"/gu;
const TRACK_LIST = /<dl class="track-list">([\s\S]*?)<\/dl>/gu;
const ROW = /<dt>([^<]{0,40})<\/dt>\s*<dd>([\s\S]{0,4000}?)<\/dd>/gu;
// The page's one row for a number DYB has no waybill under, dated at the lookup.
const NOT_FOUND = '未查询到轨迹';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A short name right before a phone in brackets: the courier in "的某某（1…）正在派件", the collector after "揽收人:".
const NAMED_PHONE = /(?:的\s*)?[^\s【】，,。；;:：！!（）()[\]]{1,12}\s*[（(]\s*(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})\s*[）)]/gu;
// A clause that names a person or gives a phone: a courier, a signer, a collector, a branch's phone, a hotline.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|快递员|业务员|派件员|揽收人|签收人|代收人|收件人|(?<![A-Z\d])\d{7,}/iu;
const BRACKETED = /【[^【】]{0,200}】|[（(][^（）()]{0,200}[）)]|\[[^[\]]{0,200}\]/gu;
const PLACE = /【([^【】]{1,60})】/u;
// Couriers in China the page may name, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/邮政|EMS/iu, 'china-post'],
];
const MAX_ROWS = 300;

/** A DYB waybill, without spaces or hyphens. */
export function normalizeDybNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DYB Express waybills are 6 to 30 letters and digits');
  return number;
}

/**
 * A row's text without the people and phones the courier's rows name: a name given with a phone
 * goes with it, then a bracket that gives a contact, then every clause that names a person or
 * gives a phone.
 */
export function dybText(value: string): string {
  const text = textFromHtml(value, 2000).replace(NAMED_PHONE, '').replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  // A comma inside a bracketed place ends no clause.
  const kept = text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u).filter((clause) => !CONTACT.test(clause));
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's wall clock to the second; a time the calendar has not is a changed page. */
function wallClock(value: string): string {
  const match = CLOCK.exec(textFromHtml(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  return local;
}

/** The courier in China and its number the page names, when that courier's rules offer the number. */
function onward(company: string, reference: string, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const named = COURIERS.filter(([name]) => name.test(company)).map(([, carrier]) => carrier);
  const delivery = normalizeTrackingNumber(reference);
  if (named.length !== 1 || !/^[A-Z0-9]{8,40}$/.test(delivery) || delivery === number) return {};
  return (detectCarrierMatch(delivery).candidates as string[]).includes(named[0]!)
    ? { delivery_carrier: named[0]!, delivery_tracking_number: delivery } : {};
}

/**
 * One waybill's page from `/order/track?no=`: the read-only fields of the result, 运单号 (the
 * waybill, which must be the number asked), 派送公司 and 派送单号 (the courier in China and its
 * number), then the rows of `track-list`, newest first, which the page says are on Beijing time.
 * A single row 未查询到轨迹 is the page's answer for a number DYB has no waybill under.
 */
export function parseDyb(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDybNumber(raw);
  const fields = [...body.matchAll(FIELD)].map((match) => [textFromHtml(match[1], 40).replace(/[:：]$/u, ''), textFromHtml(match[2], 80)] as const);
  const waybills = fields.filter(([label]) => label === '运单号');
  if (waybills.length !== 1) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without one waybill`);
  }
  if (normalizeTrackingNumber(waybills[0]![1]) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  const lists = [...body.matchAll(TRACK_LIST)];
  if (lists.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without one history`);
  const rows = [...lists[0]![1]!.matchAll(ROW)];
  if (lists[0]![1]!.replace(ROW, '').trim() || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  if (rows.length === 1 && textFromHtml(rows[0]![2], 40) === NOT_FOUND) {
    throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
  }
  const seen = new Set<string>();
  const read: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, [, clock, text]] of rows.entries()) {
    const local = wallClock(clock!);
    const description = dybText(text!);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const place = PLACE.exec(description)?.[1];
    const location = place ? clean(place, 80) : '';
    const time = isoTime(local, DYB_ZONE);
    const staged = dybStage(description);
    read.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: DYB_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  const events = read.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((row) => row.event);
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the waybill without a row`, { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const field = (label: string) => fields.find(([name]) => name === label)?.[1] ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...onward(field('派送公司'), field('派送单号'), number),
    events,
  };
}
