import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { townName } from '../../core/time/townNames.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, sunspeedyStage } from './status.js';

export const PROVIDER = 'Sunspeedy';
export const CARRIER = 'sunspeedy';
// A waybill's page is about ten kilobytes.
export const SUNSPEEDY_MAX_BYTES = 512 * 1024;
// Letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// "2016-08-12 01:42", a wall clock to the minute.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const HEADER = /^運單號\s*[:：]\s*([A-Za-z0-9 -]{1,64}?)\s*結果$/u;
// The form's message line: the tracker's answer for a waybill it does not know, and its refusal of the code.
const MISSING = '沒有找到相關記錄';
const REFUSED = '驗證碼輸入有誤';
// A row's text is wrapped in brackets: "(包裹拆封分派)".
const BRACKETED = /^[(（]([\s\S]*)[)）]$/u;
// A place the firm writes in Latin letters inside the Chinese text: "Legionowo已收件,安排至Warszawa境外包裹中轉中心".
const LATIN = /[A-Za-z][A-Za-z .'-]{2,40}[A-Za-z]/g;
// Towns the firm's rows name, by country.
const TOWNS: Readonly<Record<string, string>> = { legionowo: 'PL', warszawa: 'PL' };
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeSunspeedyNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sunspeedy waybills are 8 to 30 letters and digits');
  return number;
}

/** Whether a page is a browser check a CDN or a cloud firewall put in place of the tracker. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** The form's message line under 快件查詢, empty when the page shows a result. */
function messageOf($: CheerioAPI): string {
  return clean($('.wrapper.col4 h2').first().next('div').text(), 200);
}

/** Whether the page is the tracker's refusal of the verify code sent with the number. */
export function sunspeedyRefusedCode(html: string): boolean {
  const $ = load(html);
  return $('#delivery_id').length === 1 && messageOf($) === REFUSED;
}

function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/** The place a row names and its zone, when every place it names lies in one country that keeps one clock. */
function placeOf(description: string): { readonly location: string; readonly zone: string } | null {
  const named = (description.match(LATIN) ?? []).map((run) => {
    const country = TOWNS[run.toLowerCase()] ?? (townName(run) ? null : countryCode(run));
    return { run, zone: country ? countryTimeZone(country) : null };
  });
  const zones = new Set(named.map(({ zone }) => zone));
  const first = named[0];
  return first?.zone && zones.size === 1 ? { location: first.run, zone: first.zone } : null;
}

/**
 * The firm's history for one waybill, newest first, from the page its form posts to: a line that names the number,
 * then rows oldest first, each a wall clock and a text in brackets. 沒有找到相關記錄 in the form's message line, with
 * the number in the form, is the tracker's answer for a waybill it does not know. A row naming a place in a country
 * that keeps one clock is dated on that clock; the others, and a row dated after the lookup, keep their wall clock.
 */
export function parseSunspeedy(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeSunspeedyNumber(raw);
  if (isChallenge(html)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  const $ = load(html);
  const input = $('#delivery_id');
  if (input.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
  // The form keeps the number asked: the page's only echo when the tracker finds nothing.
  if (normalizeTrackingNumber(String(input.attr('value') ?? '')) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const message = messageOf($);
  const info = $('#info');
  if (!info.length) {
    if (message === MISSING) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    throw new SchemaError(PROVIDER, `${PROVIDER} answered its search with ${message === REFUSED ? 'a refused verify code' : 'an unknown message'}`);
  }
  const headers = info.find('div').filter((_, element) => HEADER.test(clean($(element).text(), 200)));
  if (headers.length !== 1 || message) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its waybill`);
  if (normalizeTrackingNumber(HEADER.exec(clean(headers.first().text(), 200))![1]!) !== number) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const rows = info.find('table tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const [index, element] of rows.entries()) {
    const cells = $(element).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
    const clock = clean(cells.first().text(), 40);
    // The first row heads the columns: 日期時間, 運單狀態.
    if (index === 0 && clock === '日期時間') continue;
    const local = wallClock(clock);
    const text = clean(cells.last().text(), 400);
    const description = clean(BRACKETED.exec(text)?.[1] ?? text, 400);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const place = placeOf(description);
    const instant = place ? firstOccurrence(DateTime.fromISO(local, { zone: place.zone })) : null;
    const staged = sunspeedyStage(description);
    read.push({
      ...(place && instant!.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant!.toISO({ suppressMilliseconds: true })!, time_zone: place.zone, time_zone_basis: 'place' } : {}),
      local_time: local, ...(place ? { location: place.location } : {}), description,
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
    events,
  };
}
