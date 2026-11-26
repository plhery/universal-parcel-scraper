import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { austwayStage, statusMap } from './status.js';

export const PROVIDER = 'austway';
// The sample's page is 8 kB.
export const AUSTWAY_MAX_BYTES = 512 * 1024;

// Letters and digits with a digit: the tracker answers the waybill and the delivery number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2026-05-04 07:13:35": a wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
// A row the tracker gives a status: "OutForDelivery--ON BOARD FOR DELIVERY".
const CODED = /^([A-Z][A-Za-z]{2,30})--(.+)$/;
// The page's answer when no number asked has rows.
const EMPTY = /^未查询到相关轨迹$/;
const MAX_ROWS = 300;

/** A number Austway's tracker takes: letters and digits, with a digit. */
export function normalizeAustwayNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Austway numbers are 8 to 30 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's clock as a wall clock, or its day alone when the tracker writes it at midnight. */
function clockOf(value: string): string {
  const parts = CLOCK.exec(value);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('Austway returned an unreadable row');
  return parts[4] === '00' && parts[5] === '00' && parts[6] === '00' ? day : `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/**
 * The tracker's page for the numbers posted as `orderNos`, which its server renders: a block
 * per shipment it knows, titled with the waybill (运单号) and the delivery number (派送单号),
 * then a table of its rows newest first, numbered, each with a clock, a place and a wording.
 * A page where no number asked has rows shows `未查询到相关轨迹` instead. The block read is
 * the one whose waybill or delivery number is the whole number asked.
 */
export function parseAustway(html: string, raw: string): CarrierResult {
  const number = normalizeAustwayNumber(raw);
  if (typeof html !== 'string' || !html) return invalid('Austway returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Austway answered with a browser check');
  const $ = load(html);
  if ($('form[action="/tracking.html"] textarea[name="orderNos"]').length !== 1) return invalid('Austway returned a page without its tracking form');
  const items = $('div.tracking-item').toArray();
  if (!items.length) {
    if (EMPTY.test(clean($('div.empty').text(), 80))) throw new NotFoundError(PROVIDER, 'Austway has no rows under this number');
    return invalid('Austway returned a page without its tracking result');
  }
  const mine = items.filter((item) => $(item).find('div.tracking-item-title > span').toArray()
    .some((span) => normalizeTrackingNumber(clean($(span).text(), 80)) === number));
  if (mine.length !== 1) {
    if (!mine.length) throw new IndeterminateError(PROVIDER, 'Austway answered for another number');
    return invalid('Austway returned the number in more than one shipment');
  }
  const rows = $(mine[0]).find('table tbody > tr').toArray();
  if (rows.length > MAX_ROWS) return invalid('Austway returned too many rows');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Austway lists the number without a row', { reason: 'listed' });

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 600));
    if (cells.length !== 4 || !/^\d{1,3}$/.test(cells[0]!) || !cells[3]) return invalid('Austway returned an unreadable row');
    const local = clockOf(cells[1]!);
    const location = cells[2]!.slice(0, 120);
    const coded = CODED.exec(cells[3]);
    const description = coded ? coded[2]!.trim() : cells[3];
    const code = coded ? coded[1]! : null;
    const key = JSON.stringify([local, location, cells[3]]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = austwayStage(code, description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(code ? { provider_code: code, original_description: cells[3] } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  // The tracker numbers the rows newest first; that order stands.
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
