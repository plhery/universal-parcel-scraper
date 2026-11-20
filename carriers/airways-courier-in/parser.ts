import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'airways-courier-in';

export function facilityName(text: string): string {
  return text.replace(/(?:\s+PH\s*[-:]?\s*|[-\s]|\b)(?:0\d{2,4}[- ]?)?\d{6,}.*$/i, '').replace(/\s+/g, ' ').trim();
}

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const answer = $('input#ContentPlaceHolder1_id_error');
  const waybill = $('#ContentPlaceHolder1_spn_awb_num').text().trim();
  const shipping = $('#ContentPlaceHolder1_shipping_details');
  const history = $('#ContentPlaceHolder1_status_details');
  if (answer.length !== 1 || shipping.length !== 1 || history.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'Airways Courier requires verification');
    }
    throw new SchemaError(provider, 'Missing Airways Courier tracking results');
  }
  if (answer.val() === 'Error' && !waybill && !shipping.text().trim() && !history.text().trim() &&
    $('#display_error_mssg').text().trim().startsWith('Incorrect Waybill/Reference Number')) {
    throw new NotFoundError(provider);
  }
  if (answer.val() !== 'Success' || !waybill) throw new SchemaError(provider, 'Invalid Airways Courier tracking results');
  const field = (label: string) => shipping.find('tr').filter((_, row) => $(row).children('td').first().text().trim() === label)
    .children('td:nth-child(2)').text().trim();
  const reference = field('Refrence No');
  if (field('Waybill') !== waybill || (waybill.toUpperCase() !== number && reference.toUpperCase() !== number)) {
    throw new IndeterminateError(provider, 'Airways Courier answered for another consignment');
  }

  const events: CarrierEvent[] = [];
  for (const row of history.find('tr').toArray()) {
    const columns = $(row).children('td');
    if (!columns.length) continue;
    const day = DateTime.fromFormat(columns.eq(0).text().trim(), 'dd/MM/yyyy', { zone: 'utc' }).toISODate();
    const location = facilityName(columns.eq(1).text().trim());
    const description = facilityName(columns.eq(2).text().trim());
    if (columns.length !== 3 || !day || !description) throw new SchemaError(provider, 'Invalid Airways Courier history row');
    const clock = /^DELIVERED at ([0-2]\d:[0-5]\d:[0-5]\d)\b/i.exec(description)?.[1];
    const local_time = clock && DateTime.fromISO(`${day}T${clock}`, { zone: 'utc' }).isValid ? `${day}T${clock}` : day;
    const stage = stageForWording(normalizeStatusWording(description));
    events.push({ local_time, description, ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  // The carrier orders same-day scans for which it gives no clock.
  events.sort((a, b) => b.local_time!.slice(0, 10).localeCompare(a.local_time!.slice(0, 10)));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(provider);
  const stage = events.map(scan => stageForWording(normalizeStatusWording(scan.description!))).find(Boolean);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
