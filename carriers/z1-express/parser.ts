import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, usStateTimeZone } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { statusMap, z1Stage } from './status.js';

export const PROVIDER = 'z1-express';
// A result page is about 30 kB, most of it the site's chrome.
export const Z1_MAX_BYTES = 512 * 1024;

// ZY and sixteen digits.
const NUMBER = /^ZY\d{16}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2026-07-13 11:03:33.0 Parcel Data Received-包裹预报-Shenzhen": a wall clock with a fraction, then the row.
const ROW = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})? (.+)$/;
// The only row of a number the tracker does not know.
const NO_DATA = /^暂无数据[，,]\s*请稍后查询/;
// A partner's row in the United States, as the tracker copies it: its town and state, its wording, and the
// tracker's own label for it, "null" when it has none. "Carteret,NJ, Arrived at GOFO Regional Hub,到达目的国".
const US_PARTNER = /^([^,]{1,40}),\s*([A-Z]{2}),\s*(.{1,200}),\s*(null|[^,]{0,20}\p{Script=Han}[^,]{0,20})$/u;
const HAN = /\p{Script=Han}/u;
const MAX_ROWS = 300;

/** A Z1 Express tracking number: ZY and sixteen digits. */
export function normalizeZ1Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Z1 Express tracking numbers are ZY and sixteen digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

type Scan = Pick<CarrierEvent, 'description' | 'location' | 'provider_code' | 'original_description'> & { description: string };

/**
 * A row's text after its clock: the English wording, the tracker's Chinese name for the
 * step and the place, joined by hyphens, which are read from the right so a hyphen in the
 * wording stays. The step's name becomes the provider code, and a US partner's town and
 * state, which its copied rows open with, join the place. A row of another shape keeps its
 * whole text.
 */
function scanOf(text: string): Scan {
  const place = text.lastIndexOf('-');
  const step = place > 0 ? text.lastIndexOf('-', place - 1) : -1;
  const wording = step > 0 ? text.slice(0, step).trim() : '';
  const code = step > 0 ? text.slice(step + 1, place).trim() : '';
  const where = text.slice(place + 1).trim();
  if (!wording || !HAN.test(code) || code.length > 40 || where.length > 40) return { description: text };
  const partner = US_PARTNER.exec(wording);
  const town = partner && usStateTimeZone(partner[2]) ? `${partner[1]!.trim()}, ${partner[2]}` : '';
  const location = [town, where].filter(Boolean).join(', ');
  return {
    description: town ? partner![3]!.trim() : wording, provider_code: code,
    ...(location ? { location } : {}), original_description: text,
  };
}

/**
 * The tracker's page for one number, `index.php?m=home&c=Search&a=track&trackNumber=`,
 * which its server renders: the number asked in its search box, then a table with a row
 * per number it knows, the number beside its rows oldest first, one per line. A number the
 * tracker does not know gets no row of its own, only `暂无数据，请稍后查询...` when no
 * number asked has rows.
 */
export function parseZ1(html: string, raw: string): CarrierResult {
  const number = normalizeZ1Number(raw);
  if (typeof html !== 'string' || !html) return invalid('Z1 Express returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Z1 Express answered with a browser check');
  const $ = load(html);
  const box = $('input[name="trackNumber"]');
  const table = $('table.search_track');
  if (box.length !== 1 || table.length !== 1) return invalid('Z1 Express returned a page without its tracking result');
  if (normalizeTrackingNumber(clean(box.attr('value'), 80)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Z1 Express answered for another number');
  }
  const rows = table.find('tbody > tr').toArray();
  if (rows.length === 1 && NO_DATA.test(clean($(rows[0]).text(), 80))) {
    throw new NotFoundError(PROVIDER, 'Z1 Express has no data under this number');
  }
  const mine = rows.filter((row) => normalizeTrackingNumber(clean($(row).children('td.search_track_th1').text(), 80)) === number);
  if (mine.length !== 1) {
    if (!mine.length && rows.length) throw new IndeterminateError(PROVIDER, 'Z1 Express answered for another number');
    return invalid('Z1 Express returned an unexpected tracking result');
  }
  const cell = $(mine[0]).children('td.search_track_th2');
  if (cell.length !== 1) return invalid('Z1 Express returned a number without its rows');
  const lines = (cell.html() ?? '').split(/<br\s*\/?>/i).map((line) => textFromHtml(line, 600)).filter(Boolean);
  if (lines.length > MAX_ROWS) return invalid('Z1 Express returned too many rows');
  if (!lines.length) throw new NoHistoryError(PROVIDER, 'Z1 Express lists the number without a row', { reason: 'listed' });

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const parts = ROW.exec(line);
    const date = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
    if (!parts || !date || Number(parts[1]) < 2000) return invalid('Z1 Express returned an unreadable row');
    const local = `${date}T${parts[4]}:${parts[5]}:${parts[6]}`;
    const scan = scanOf(parts[7]!.trim());
    const key = JSON.stringify([local, scan.original_description ?? scan.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = z1Stage(scan.provider_code ?? null, scan.description);
    events.push({ local_time: local, ...scan, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  // The tracker lists the rows oldest first, in the order it wrote them; that order stands, newest first.
  events.reverse();
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    ...(events[0]!.provider_code ? { provider_code: events[0]!.provider_code } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    events,
  };
}
