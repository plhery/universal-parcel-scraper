import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { abxStage, statusMap } from './status.js';

export const PROVIDER = 'ABX Express';
export const CARRIER = 'abx-express';
export const ABX_ORIGIN = 'https://www.abxexpress.com.my';
/** The tracking page, whose form carries the anti-forgery token. */
export const ABX_SEARCH = `${ABX_ORIGIN}/tracking`;
/** Where the form posts the number. */
export const ABX_TRACK = `${ABX_ORIGIN}/Home/Track`;
/** Malaysia keeps one zone, without daylight saving time. */
export const ABX_ZONE = 'Asia/Kuala_Lumpur';
// The tracking page is about 90 kB.
export const ABX_PAGE_MAX_BYTES = 512 * 1024;
// A delivered parcel's page embeds its delivery photos, four copies of each, about 4 MB in all for four
// photos; the cap leaves room for larger ones.
export const ABX_RESULT_MAX_BYTES = 16 * 1024 * 1024;

// Letters and digits, with a digit: CNMYA and nine digits, or EZP and twelve, on the public samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,1024}$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// The one row the page lists for a number it holds nothing under, dated at the moment of the lookup.
const NO_RECORD = /^No record available$/i;
// The delivery photos, embedded as data URIs and passed to a script: dropped before the page is read.
const EMBEDDED_IMAGE = /data:image\/[a-z0-9.+-]{1,20};base64,[A-Za-z0-9+/=\s]*/gi;
const IMAGE_ARGUMENT = /openBase64Image\('[^']*'\)/g;
// Bot checks the site's firewall or a CDN could put in place of the page.
const CHALLENGE = /acw_sc__v2|aliyun_waf|errors\.aliyun\.com|_waf_[a-z0-9]{8}|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha/i;
const MAX_ROWS = 300;

/** A consignment number for ABX Express's tracker, without spaces or hyphens. */
export function normalizeAbxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ABX Express consignment numbers are 8 to 30 letters and digits');
  return number;
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isAbxChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isAbxChallenge(html)) throw new ChallengeError(PROVIDER, 'ABX Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The anti-forgery token of the tracking page's form. */
export function parseAbxForm(html: string): string {
  const $ = load(html);
  const forms = $('form[action="/Home/Track"]');
  if (forms.length !== 1 || forms.find('input[name="ConsignmentNo"]').length !== 1) unexpected(html, 'ABX Express tracking page has no tracking form');
  const tokens = forms.find('input[name="__RequestVerificationToken"]');
  const token = tokens.length === 1 ? tokens.attr('value') ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'ABX Express tracking form changed');
  return token;
}

/** The result panel's rows, by their label without its colon. */
function summary($: CheerioAPI): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  $('.panel-info .row.no-gutters').each((_index, row) => {
    const label = clean($(row).children('.col-md-3').first().text(), 60).replace(/:$/, '');
    const value = clean($(row).children('.col-md-9').first().text(), 200);
    if (label) fields.set(label, [...(fields.get(label) ?? []), value]);
  });
  return fields;
}

/** A row's date and clock, as an ISO wall clock to the second, checked against the calendar. */
function wallClock(dateText: string, clockText: string): string {
  const date = DATE.exec(dateText);
  const clock = CLOCK.exec(clockText);
  const day = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!day || !clock) throw new SchemaError(PROVIDER, 'ABX Express returned an invalid scan time');
  return `${day}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}`;
}

interface Row { readonly local: string; readonly location: string; readonly description: string }

/**
 * ABX Express's result page for one consignment number: the number, the current status and, once
 * delivered, the delivery date above the history, newest first. Each row names the hub or state,
 * the status and the date and clock, with no zone; ABX delivers in Malaysia alone, so each is read
 * on Malaysia's clock, unless that would date it after the lookup. The delivery photos and the
 * phone numbers the page hides behind them are not read.
 */
export function parseAbx(page: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeAbxNumber(raw);
  const html = page.replace(EMBEDDED_IMAGE, 'data:,').replace(IMAGE_ARGUMENT, "openBase64Image('')");
  const $ = load(html);
  const fields = summary($);
  const shown = fields.get('Shipment No') ?? [];
  if (shown.length === 0) {
    if ($('form[action="/Home/Track"] input[name="ConsignmentNo"]').length > 0) {
      throw new IndeterminateError(PROVIDER, 'ABX Express returned its tracking form instead of a result');
    }
    unexpected(html, 'ABX Express returned a page without its tracking result');
  }
  if (shown.length > 1) throw new IndeterminateError(PROVIDER, 'ABX Express answered for several shipments');
  if (normalizeTrackingNumber(shown[0]!) !== number) throw new IndeterminateError(PROVIDER, 'ABX Express answered for another number');

  const items = $('.tracking ul[id="first-list"] > li').toArray();
  if (items.length === 0) throw new SchemaError(PROVIDER, 'ABX Express returned a result without its history');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ABX Express returned an oversized history');
  const unrecorded = items.filter((item) => NO_RECORD.test(clean($(item).children('div.info').text(), 200)));
  // The page's answer for a number it holds nothing under: the one row saying so.
  if (unrecorded.length > 0) {
    if (items.length === 1) throw new NotFoundError(PROVIDER, 'ABX Express has no record of this number');
    throw new SchemaError(PROVIDER, 'ABX Express listed a history beside its no-record row');
  }

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const item of items) {
    const description = clean($(item).children('div.info').text(), 200);
    const spans = $(item).children('div.time').children('span');
    if (!description || spans.length !== 2) throw new SchemaError(PROVIDER, 'ABX Express returned an incomplete scan');
    const local = wallClock(clean(spans.eq(0).text(), 20), clean(spans.eq(1).text(), 20));
    const location = clean($(item).children('div.title').text(), 120);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ local, location, description });
  }

  // Newest first, as the page lists them; rows that share a clock keep its order.
  const events: CarrierEvent[] = rows.map((row, index) => ({ row, index }))
    .sort((left, right) => right.row.local.localeCompare(left.row.local) || left.index - right.index)
    .map(({ row }) => {
      const instant = isoTime(row.local, ABX_ZONE);
      if (!instant) throw new SchemaError(PROVIDER, 'ABX Express returned an invalid scan time');
      const staged = abxStage(row.description);
      return {
        ...(instant.timestamp <= readAt + CLOCK_SKEW_MS ? { time: instant.iso, time_zone: ABX_ZONE, time_zone_basis: 'carrier' } : {}),
        local_time: row.local,
        ...(row.location ? { location: row.location } : {}),
        description: row.description,
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      };
    });
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);

  // The current status above the history gives the stage when the map knows it, else the scans do.
  const current = clean(fields.get('Current Status')?.[0], 200);
  const mapped = current ? abxStage(current) : null;
  const lead = mapped ? null : leadingScan(events, statusMap);
  const stage = (mapped?.stage ?? lead?.stage) as Stage | undefined;
  const source = mapped?.source ?? lead?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: current || String(newest.description),
    last_update: newest.time ?? null,
    last_update_local: String(newest.local_time),
    expected_delivery: null,
    events,
  };
}
