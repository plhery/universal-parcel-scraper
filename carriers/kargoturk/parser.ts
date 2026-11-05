import { load } from 'cheerio';
import { isKargoturkReference } from '../../core/detection/kargoturk.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { kargoturkNotice, kargoturkStage } from './status.js';

export const PROVIDER = 'KargoTurk';
export const KARGOTURK_MAX_BYTES = 1024 * 1024;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|403 Forbidden/i;

export function normalizeKargoturkNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'KargoTurk needs a shipment barcode');
  if (!isKargoturkReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function clock(date: string, time: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (!day || (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new SchemaError(PROVIDER, 'KargoTurk returned an invalid scan clock');
  return time ? `${day}T${time}:00` : day;
}

function summaryStage(wording: string): Stage | undefined {
  return normalizeStatusWording(wording) === normalizeStatusWording('Teslim') ? 'delivered'
    : normalizeStatusWording(wording) === normalizeStatusWording('İade (Müşteride)') ? 'returned' : undefined;
}

export function parseKargoturk(html: string, raw: string): CarrierResult {
  const number = normalizeKargoturkNumber(raw);
  if (new TextEncoder().encode(html).byteLength > KARGOTURK_MAX_BYTES) throw new SchemaError(PROVIDER, 'KargoTurk returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'KargoTurk requires browser verification');
  const $ = load(html), root = $('main.trk-main'), alerts = root.find('.trk-alert.danger');
  if ($('title').length !== 1 || clean($('title').text()) !== 'Kargo Takip' || root.length !== 1) throw new SchemaError(PROVIDER, 'KargoTurk returned no unique tracking page');
  if (alerts.length) {
    const form = root.find('form.trk-search-form');
    if (alerts.length === 1 && clean(alerts.children('span').text()) === 'Kargo takip kodu bulunamadı.'
      && !root.find('.trk-status-barcode, .trk-info-row, table.trk-table').length
      && form.length === 1 && form.attr('method')?.toUpperCase() === 'GET' && form.attr('action') === '/tracking'
      && form.find('input[name="har_kod"]').length === 1
      && clean(root.find('.trk-search-desc').text()) === 'Girdiğiniz bilgilerle eşleşen bir kayıt bulunamadı') throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'KargoTurk returned a mixed or changed error view');
  }
  const barcode = root.find('.trk-status-barcode');
  const labelled = root.find('.trk-info-row').filter((_, el) => clean($(el).children('.trk-info-label').text()) === 'Müşteri Barkod').children('.trk-info-value');
  const summary = root.find('.trk-status-left .trk-status-text > h2');
  if (barcode.length !== 1 || labelled.length !== 1 || summary.length !== 1 || !summary.text().trim() || summary.text().length > 200
    || [barcode.text(), labelled.text()].some(value => value.length > 64 || normalizeTrackingNumber(value) !== number)) {
    throw new SchemaError(PROVIDER, 'KargoTurk returned another shipment or changed its heading');
  }
  const table = root.find('table.trk-table'), rows = table.find('tbody tr');
  if (table.length !== 1 || table.find('thead th').toArray().map(el => clean($(el).text())).join('|') !== 'Şube|Kurye|İşlem|Tarih|Saat|Kanıt'
    || rows.length > 500) throw new SchemaError(PROVIDER, 'KargoTurk changed its scan table');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'KargoTurk returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows.toArray().reverse()) {
    const cells = $(row).children('td');
    if (cells.length !== 6 || cells.eq(0).text().length > 200 || cells.eq(2).text().length > 500) throw new SchemaError(PROVIDER, 'KargoTurk returned a malformed scan');
    // Courier names and proof cells are separate from the branch and operation columns.
    const description = clean(cells.eq(2).text()), location = clean(cells.eq(0).text());
    if (!description) throw new SchemaError(PROVIDER, 'KargoTurk returned a scan without its activity');
    const stage = kargoturkStage(description);
    const event: CarrierEvent = { local_time: clock(clean(cells.eq(3).text()), clean(cells.eq(4).text())), description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const newest = events[0]!, stated = summaryStage(clean(summary.text()));
  let stage = kargoturkStage(newest.description!);
  if (!stage && kargoturkNotice(newest.description!)) {
    const previous = events.find(event => event.stage)?.stage;
    if (previous === 'accepted' || previous === 'in_transit' || previous === 'out_for_delivery' || previous === 'exception') stage = previous;
    else if (previous === stated && (previous === 'delivered' || previous === 'returned')) stage = previous;
  }
  if (stated && stage && stage !== stated) throw new SchemaError(PROVIDER, 'KargoTurk returned a contradictory current status');
  if (!stated && (stage === 'delivered' || stage === 'returned')) stage = undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
