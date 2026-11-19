import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { apgEcommerceStage } from './status.js';

export const PROVIDER = 'APG eCommerce Solutions';
export const APG_MAX_BYTES = 1024 * 1024;
const TRACKER = 'https://apgecommerce.com/track-result/';
const BLOCKED = /_cf_chl_opt|<title>\s*(?:Just a moment|Attention Required|Access Denied)|verify (?:that )?you are human/i;
const COLUMNS = ['Date', 'Local Time', 'Location', 'Event', 'Event Description'];

export function normalizeApgReference(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'APG needs a shipment reference');
  if (!/^\d{14}$/.test(number)) {
    throw new NoHistoryError(PROVIDER, 'APG guest history supports its fourteen-digit tracking reference', { reason: 'unsupported_reference' });
  }
  return number;
}

export function apgTrackingUrl(number: string): string {
  return TRACKER + '?' + new URLSearchParams({ track_sequenceNo: number }).toString();
}

function timestamp(date: string, time: string): string {
  const parts = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date);
  const day = parts && calendarDay(2000 + Number(parts[3]), Number(parts[2]), Number(parts[1]));
  const clock = /^((?:[01]\d|2[0-3]):[0-5]\d) GMT$/.exec(time);
  if (!day || !clock) throw new SchemaError(PROVIDER, 'APG returned an unsupported scan clock');
  return `${day}T${clock[1]}:00Z`;
}

export function parseApgHistory(html: string, number: string): CarrierResult {
  if (new TextEncoder().encode(html).byteLength > APG_MAX_BYTES) throw new SchemaError(PROVIDER, 'APG returned an oversized tracking page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'APG returned browser verification');
  const $ = load(html);
  const root = $('.tracking-elements > .tracking');
  const title = root.find('.tracking-head > #tracking-title');
  if (root.length !== 1 || title.length !== 1 || !/APG\s+eCommerce/i.test($('title').text())) {
    throw new SchemaError(PROVIDER, 'APG returned no unique tracking result');
  }
  const heading = clean(title.text());
  const missing = /^Reference No\. (\d{14})$/i.exec(heading);
  const body = root.children('.traking-body');
  if (missing?.[1] === number && !body.length && !root.find('table').length) {
    const status = root.find('.tracking-status-text');
    if (status.length === 1 && /^Sorry, order not found$/i.test(clean(status.text()))) throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER, 'APG returned a reference without a tracking history');
  }
  const tracked = /^Order No\. [A-Z0-9-]{1,80} \/ Tracking No\. (\d{14})$/i.exec(heading);
  if (tracked?.[1] !== number) throw new SchemaError(PROVIDER, 'APG returned a result for another reference');

  const table = body.find('div.tracking-table > table');
  const headers = table.find('thead > tr > th').toArray().map(cell => clean($(cell).text()));
  const rows = table.find('tbody > tr').toArray();
  if (body.length !== 1 || table.length !== 1 || table.children('tbody').length !== 1
    || headers.length !== COLUMNS.length || !COLUMNS.every((column, index) => headers[index] === column) || rows.length > 500) {
    throw new SchemaError(PROVIDER, 'APG changed its scan table');
  }
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let omitted = false;
  for (const row of rows) {
    const columns = $(row).children('td');
    if (columns.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'APG returned an invalid scan row');
    const date = clean(columns.eq(0).text()), time = clean(columns.eq(1).text());
    const location = clean(columns.eq(2).text()), description = clean(columns.eq(4).text());
    const scanTime = timestamp(date, time);
    // A description outside APG's short wording (a digit, an address, markup, a link or a signer)
    // costs only its own row, and a place that is not a country code only that place.
    if (!description || description.length > 140 || /[\d@<>]|https?:/i.test(description) || hasPrivateDeliveryDetails(description)) {
      omitted = true;
      continue;
    }
    const country = /^[A-Z]{2}$/.test(location) ? location : '';
    const stage = apgEcommerceStage(description);
    const scan = { time: scanTime, description, ...(country ? { location: country } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(scan);
    if (!seen.has(key)) { seen.add(key); events.push(scan); }
  }
  if (!events.length && omitted) throw new SchemaError(PROVIDER, 'APG returned no readable scan');
  if (!events.length) throw new NoHistoryError(PROVIDER, 'APG returned a bound result without scans');
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const latest = events[0]!;
  const stage = apgEcommerceStage(latest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_update: latest.time!, last_status_text: latest.description!, expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 || omitted ? { history_truncated: true } : {}) };
}
