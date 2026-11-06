import { load } from 'cheerio';
import { isCityAirExpressReference } from '../../core/detection/cityAirExpress.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { cityAirExpressStage } from './status.js';

export const PROVIDER = 'City Air Express';
export const TRACKING_BASE = 'https://caebfs.netcourier.net/online/tracking/trackinginfo/';
export const MAX_BYTES = 1024 * 1024;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const KNOWN_WORDING = new Map([
  ['delivered', 'Delivered'],
  ['job received at belfast depot', 'Job received at Belfast Depot'],
  ['data processed at caebfs', 'Data processed at CAEBFS'],
]);

export function normalizeCityAirExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'City Air Express needs a waybill');
  if (!isCityAirExpressReference(number)) {
    throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this waybill series', { reason: 'unsupported_reference' });
  }
  return number;
}

function clock(value: string): string {
  const match = /^(\d{2}) ([A-Za-z]{3}) (\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const year = Number(match?.[3]);
  const day = match && year >= 2000 && year <= 2100
    ? calendarDay(year, MONTHS.indexOf(match[2]!.toLowerCase()) + 1, Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'City Air Express returned an invalid scan clock');
  return day + 'T' + match[4] + ':' + match[5];
}

function publicWording(wording: string, localTime: string): string {
  const known = KNOWN_WORDING.get(wording.toLowerCase());
  if (known) return known;
  const delivery = /^Delivered to .{1,400} at ([01]\d|2[0-3]):([0-5]\d) on (\d{2})-(\d{2})-(\d{4})$/i.exec(wording);
  if (!delivery) return 'Tracking update';
  const day = calendarDay(Number(delivery[5]), Number(delivery[4]), Number(delivery[3]));
  if (!day || day + 'T' + delivery[1] + ':' + delivery[2] !== localTime) {
    throw new SchemaError(PROVIDER, 'City Air Express returned contradictory delivery clocks');
  }
  return 'Delivered';
}

/** Public logistics rows only; recipient prose and postcode-protected details stay on the page. */
export function parseCityAirExpress(html: string, raw: string): CarrierResult {
  const number = normalizeCityAirExpressNumber(raw);
  if (html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) {
    throw new SchemaError(PROVIDER, 'City Air Express returned too much tracking data');
  }
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|>\s*Verify (?:that )?you are human/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'City Air Express returned browser verification');
  }
  const $ = load(html); $('script,style,template').remove();
  const headings = $('h3').filter((_, element) => /^TRACKING FOR\b/i.test(clean($(element).text())));
  const absence = $('span').filter((_, element) => !$(element).children().length
    && !$(element).closest('.nodisplay,.hide,[hidden]').length
    && /^Sorry, we could not find job\b/.test(clean($(element).text())));
  if (absence.length) {
    if (absence.length === 1 && clean(absence.text()) === 'Sorry, we could not find job ' + number + '.'
      && !headings.length && !$('.event,.scrollable').length) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'City Air Express returned a mixed or unrelated absence notice');
  }
  if (headings.length !== 1 || clean(headings.text()) !== 'TRACKING FOR ' + number
    || !headings.parent().hasClass('tracking-header')) {
    throw new SchemaError(PROVIDER, 'City Air Express returned no matching whole waybill');
  }
  const panel = headings.closest('.rounded-border'), history = panel.find('.scrollable');
  if (panel.length !== 1 || history.length !== 1 || $('.scrollable').length !== 1) {
    throw new SchemaError(PROVIDER, 'City Air Express changed its history container');
  }
  const rows = history.children('.event');
  if (rows.length !== $('.event').length || rows.length > 500) {
    throw new SchemaError(PROVIDER, 'City Air Express returned unrelated or excessive scan rows');
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'City Air Express knows the waybill but returned no dated history', { reason: 'parcel_found' });
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let partial = false;
  for (const row of rows.toArray()) {
    const content = $(row).children('.event-content'), status = content.children('.event-status');
    const date = content.children('.event-date-time'), time = date.children('.event-time');
    if (content.length !== 1 || status.length !== 1 || date.length !== 1 || time.length !== 1
      || clean(date.text()) !== clean(time.text())) {
      throw new SchemaError(PROVIDER, 'City Air Express changed a scan row');
    }
    const wording = clean(status.text(), 1001);
    if (!wording || wording.length > 1000) throw new SchemaError(PROVIDER, 'City Air Express returned an invalid scan description');
    const local_time = clock(clean(time.text(), 80));
    const description = publicWording(wording, local_time);
    if (description === 'Tracking update') partial = true;
    const stage = cityAirExpressStage(null, description);
    const key = JSON.stringify([local_time, wording]);
    if (!seen.has(key)) {
      seen.add(key);
      events.push({ local_time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
    }
  }
  const newest = events[0]!, stage = cityAirExpressStage(null, newest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null,
    ...(partial || events.length > 100 ? { history_truncated: true } : {}),
    events: events.slice(0, 100),
  };
}
