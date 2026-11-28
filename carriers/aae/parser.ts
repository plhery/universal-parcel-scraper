import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { aaeStage, statusMap } from './status.js';

export const PROVIDER = 'AAE';
export const CARRIER = 'aae';
/** The site, which answers plain HTTP only. */
export const AAE_ORIGIN = 'http://cn.aaeweb.com';
/** The tracking page, which opens the anonymous session and gives the token its lookups carry. */
export const AAE_PAGE = `${AAE_ORIGIN}/searchwaybill`;
/** The page's lookup handler; the number goes in the query. */
export const AAE_TRACK = `${AAE_ORIGIN}/SearchWaybill?handler=Tracking`;
// The page is under 20 kB; a waybill's rows come to a few kilobytes.
export const AAE_PAGE_MAX_BYTES = 256 * 1024;
export const AAE_RESULT_MAX_BYTES = 256 * 1024;

// Kuaidi100's carrier list gives AAE's China waybills as nine or ten digits.
const NUMBER = /^\d{9,10}$/;
const TOKEN = /<input\b[^>]*\bname="__RequestVerificationToken"[^>]*\bvalue="([A-Za-z0-9_-]{20,400})"/;
const TOKEN_REVERSED = /<input\b[^>]*\bvalue="([A-Za-z0-9_-]{20,400})"[^>]*\bname="__RequestVerificationToken"/;
const ITEM = /<div class="dcc-item">/g;
const ROW = /<li class="scl-item">\s*<p class="create-time[^"]*">([^<]*)<\/p>[\s\S]*?<p class="state-txt[^"]*">([\s\S]*?)<\/p>\s*<\/li>/g;
const ERROR_NUMBER = /<p class="dcci-number[^"]*\bdcci-number-error[^"]*">([^<]{1,40})<\/p>/;
const NOT_FOUND = '没有找到这个跟踪号的结果';
// "2016-07-06 08:33": the row's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// "[洛杉矶分拨中心] 货件到达洛杉矶分拨中心": the branch or hub that wrote the row, then its wording.
const STATION = /^\[([^[\]]{1,40})\]\s*/u;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const MAX_ROWS = 300;

/** An AAE China waybill number, as its tracker takes it. */
export function normalizeAaeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AAE waybill numbers are nine or ten digits');
  return number;
}

/** Whether a page reads as a bot check rather than the tracker. */
export function isAaeChallenge(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The anti-forgery token the tracking page gives its lookups. */
export function parseAaeToken(html: string): string {
  const token = TOKEN.exec(html)?.[1] ?? TOKEN_REVERSED.exec(html)?.[1];
  if (!token) throw new SchemaError(PROVIDER, 'AAE returned a tracking page without its form token');
  return token;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * Reads the handler's answer for one number: a block with the progress bar and the rows newest first, each
 * a wall clock without a zone and a Chinese wording opened by the bracketed branch that wrote it. A found
 * waybill's block does not repeat the number, so a lookup asks one number at a time; an unknown number gets
 * a block naming it with a sentence instead of rows.
 */
export function parseAae(html: string, raw: string): CarrierResult {
  const number = normalizeAaeNumber(raw);
  const items = html.match(ITEM)?.length ?? 0;
  if (items !== 1) return invalid(items ? 'AAE answered about more than one waybill' : 'AAE returned a reply without its tracking block');
  const named = ERROR_NUMBER.exec(html)?.[1];
  if (named !== undefined) {
    if (normalizeTrackingNumber(named) !== number) throw new IndeterminateError(PROVIDER, 'AAE answered about another number');
    if (textFromHtml(html, 2000).includes(NOT_FOUND)) throw new NotFoundError(PROVIDER, 'AAE has no waybill under this number');
    return invalid('AAE returned an error block without its not-found answer');
  }
  const rows = [...html.matchAll(ROW)].map((match) => [textFromHtml(match[1], 40), textFromHtml(match[2], 400)] as const);
  if (!rows.length) return invalid('AAE returned neither rows nor its not-found answer');
  if (rows.length > MAX_ROWS) return invalid('AAE returned too many rows');
  const seen = new Set<string>();
  const events = rows.map(([value, text], index) => {
    const clock = CLOCK.exec(value);
    const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
    if (!clock || !day) return invalid('AAE returned a row without a readable time');
    const description = text.slice(0, 300);
    if (!description) return invalid('AAE returned a row without a wording');
    const location = STATION.exec(description)?.[1]?.trim();
    const staged = aaeStage(description);
    const event: CarrierEvent & { local_time: string } = {
      local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6] ?? '00'}`, description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}
