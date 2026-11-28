import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { besterStage, statusMap } from './status.js';

export const PROVIDER = 'Bester Express';
export const CARRIER = 'bester';
// The fragment is a couple of kilobytes for a handful of rows.
export const BESTER_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: SWE and nine digits, or eleven digits, on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The fragment's answer for a number it holds nothing under: "sorry, nothing matches".
const NOT_FOUND = '抱歉，没有找到符合条件的信息';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The page the fragment belongs to, or any whole page: its own `nodata` block is not an answer.
const WHOLE_PAGE = /<(?:html|head|body)\b/i;
// "2017-JUL-31 11:07": the month in English capitals, to the minute.
const CLOCK = /^(\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2})$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// Taiwan's clock. The firm's offices in Taiwan and in China both keep UTC+8.
const TAIWAN = 'Asia/Taipei';
const MAX_ROWS = 100;
// "转运单：EMS:9975104606094": the courier the parcel goes on with, and its number.
const HANDOFF = /^转运单\s*[:：]\s*([A-Za-z\p{Script=Han}]{1,20})\s*[:：]\s*([A-Za-z0-9]{8,30})$/u;
// Couriers a hand-off may name, as the page writes them, with the catalog's id.
const COURIERS: readonly (readonly [RegExp, string])[] = [[/^(?:EMS|中国邮政|中國郵政|邮政|郵政)$/iu, 'china-post']];
// A branch in Taiwan, as a row's place names it: the parcel left from Taiwan.
const TAIWAN_PLACE = /桃園|桃园|臺北|台北|新北|臺中|台中|臺南|台南|高雄|基隆|新竹|臺灣|台灣|台湾/u;
// A phone, or a clause that names who signed: neither belongs in a row's text.
const PHONE = /(?<!\d)(?:09\d{2}-?\d{3}-?\d{3}|1[3-9]\d{9}|0\d{1,3}-?\d{6,8})(?!\d)/gu;
const SIGNER = /[，,；;]?\s*(?:簽收人|签收人|收件人|收貨人|收货人)\s*[:：]?[^，,；;。]*/gu;

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeBesterNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bester Express numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the fragment. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A reply that is not the tracking fragment: a browser check, or a changed page. */
function notTrackingFragment(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking fragment`);
}

/** A row's wall clock, checked against the calendar. */
function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40).toUpperCase());
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  const local = match && month ? `${match[1]}-${String(month).padStart(2, '0')}-${match[3]}T${match[4]}:${match[5]}:00` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/** A line of a row's text without phones or who signed. */
export function besterText(raw: string): string {
  return clean(clean(raw, 500).replace(SIGNER, '').replace(PHONE, ''), 300).replace(/[，,。；;：:\s]+$/u, '');
}

interface Row {
  readonly local: string;
  readonly place: string;
  readonly description: string;
  readonly original?: string;
  readonly handoff?: { readonly courier: string; readonly number: string };
}

function rowOf($: CheerioAPI, item: Element): Row {
  const row = $(item);
  const clock = row.find('div.date');
  const text = row.find('div.p2').first().clone();
  if (clock.length !== 1 || text.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
  const place = clean(text.find('span.red').first().text(), 60);
  text.find('span.red').remove();
  text.find('br').replaceWith('\n');
  const lines = text.text().split('\n').map((line) => clean(line, 500)).filter(Boolean);
  let handoff: Row['handoff'];
  const said: string[] = [];
  const whole: string[] = [];
  for (const line of lines) {
    const found = HANDOFF.exec(line.replace(/\s+/gu, ''));
    if (found) {
      handoff = { courier: found[1]!, number: normalizeTrackingNumber(found[2]!) };
      whole.push(line);
      continue;
    }
    const text = besterText(line);
    said.push(text);
    whole.push(text);
  }
  const description = clean(said.filter(Boolean).join(' '), 300);
  return {
    local: wallClock(clock.text()), place, description,
    ...(handoff && description ? { original: clean(whole.filter(Boolean).join(' '), 300) } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

/** The rows of the fragment, oldest first as the page lists them. Its `nodata` block alone is not found. */
function rowsOf(body: string): Row[] {
  if (WHOLE_PAGE.test(body)) notTrackingFragment(body);
  const $ = load(body);
  const list = $('div.boxs > ul');
  if (!list.length) {
    const nodata = $('div.nodata');
    if (nodata.length === 1 && clean(nodata.find('.title').text(), 100) === NOT_FOUND) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    }
    notTrackingFragment(body);
  }
  const items = list.first().children('li').toArray();
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return items.map((item) => rowOf($, item));
}

/** The courier the newest hand-off names, by its catalog id, when that courier's own rules take the number. */
function partnerOf(rows: readonly Row[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const handoff = [...rows].reverse().find((row) => row.handoff)?.handoff;
  if (!handoff || handoff.number === number) return {};
  const named = COURIERS.find(([name]) => name.test(handoff.courier))?.[1];
  if (!named || !(detectCarrierMatch(handoff.number).candidates as string[]).includes(named)) return {};
  return { delivery_carrier: named, delivery_tracking_number: handoff.number };
}

function dated(local: string, readAt: number): Partial<CarrierEvent> {
  const instant = firstOccurrence(DateTime.fromISO(local, { zone: TAIWAN }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: TAIWAN, time_zone_basis: 'carrier' } : {};
}

/**
 * Bester Express's history for one waybill, newest first: the fragment `orderAjax` gives the waybill page,
 * a list of rows oldest first with a clock to the minute, the office that wrote the row and its text. The
 * fragment does not name the number; a number it holds nothing under gets its `nodata` block instead. The
 * firm's offices in Taiwan and China both keep UTC+8, so every row is dated on Taiwan's clock.
 */
export function parseBester(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeBesterNumber(raw);
  const rows = rowsOf(body);
  const events: CarrierEvent[] = rows.filter((row) => row.description).reverse().map((row) => {
    const staged = besterStage(row.description);
    return {
      ...dated(row.local, readAt),
      local_time: row.local,
      ...(row.place ? { location: row.place } : {}),
      description: row.description,
      ...(row.original && row.original !== row.description ? { original_description: row.original } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const partner = partnerOf(rows, number);
  const origin = rows.find((row) => row.place)?.place;
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(origin && TAIWAN_PLACE.test(origin) ? { origin_country: 'TW' } : {}),
    ...(partner.delivery_carrier ? { destination_country: 'CN' } : {}),
    ...partner,
    events,
  };
}
