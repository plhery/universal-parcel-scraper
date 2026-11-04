import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { rincosStage } from './status.js';

export const PROVIDER = 'Rincos';
export const RINCOS_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const BLOCKED = /captcha|_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Incapsula incident|Request unsuccessful|_Incapsula_Resource|verify (?:that )?you are human|bot verification|403 Forbidden/i;

/** This is lookup validation, not a detection rule or evidence of ownership. */
export function normalizeRincosNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^82\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Rincos needs its own fourteen-digit tracking number');
  return number;
}

function clock(raw: string): Pick<CarrierEvent, 'local_time' | 'time'> {
  const match = /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(raw);
  if (!match) throw new SchemaError(PROVIDER, 'Rincos returned an invalid scan clock');
  const local = `${match[1]}T${match[2]}`;
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat(match[2]!.length === 5 ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Rincos returned an invalid scan calendar');
  }
  const offset = match[3];
  if (!offset) return { local_time: local };
  const stated = explicitOffsetTime(local + offset);
  if (!stated) throw new SchemaError(PROVIDER, 'Rincos returned an invalid stated scan offset');
  return { local_time: local, time: stated.iso };
}

function locationText(raw: string, description: string): string {
  const location = clean(raw, 160);
  // System names and the partner's field tokens identify no scanning facility.
  return /^(?:RINNIS SYSTEM|[A-Z_]+\([A-Z]{2,}\))$/.test(location) || location === description ? '' : location;
}

/** Both history panels are already rendered, including the collapsed destination panel. */
export function parseRincos(html: string, raw: string): CarrierResult {
  const number = normalizeRincosNumber(raw);
  if (new TextEncoder().encode(html).byteLength > RINCOS_MAX_BYTES) throw new SchemaError(PROVIDER, 'Rincos returned an oversized tracking page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Rincos answered with browser verification');
  const $ = load(html), form = $('form#frm');
  if (form.length !== 1 || form.find('input[name="P_VAL"]').length !== 1
    || normalizeTrackingNumber(form.find('input[name="P_VAL"]').attr('value') ?? '') !== number
    || form.find('input[name="SCGBN"]').length !== 1 || form.find('input[name="SCGBN"]').attr('value') !== '20') {
    throw new SchemaError(PROVIDER, 'Rincos returned no unique matching lookup form');
  }
  const details = form.find('table.type_detail');
  if (details.length !== 1) throw new SchemaError(PROVIDER, 'Rincos returned no unique shipment details');
  const fields = new Map<string, string>();
  for (const heading of details.find('th').toArray()) {
    const label = clean($(heading).text(), 100), value = $(heading).next('td').clone();
    if (fields.has(label) || value.length !== 1) throw new SchemaError(PROVIDER, 'Rincos changed its shipment detail fields');
    if (label === 'Rincos Tracking No.') {
      const print = value.find('#btn_print2');
      if (print.length > 1) throw new SchemaError(PROVIDER, 'Rincos duplicated its invoice control');
      if (print.length) {
        const wrapper = print.parent('span');
        if (wrapper.length !== 1 || clean(wrapper.text()) !== '--Invoice Print--') throw new SchemaError(PROVIDER, 'Rincos changed its shipment identity field');
        wrapper.remove();
      }
    }
    fields.set(label, value.text().trim());
  }
  const identity = fields.get('Rincos Tracking No.');
  const summary = fields.get('STATUS');
  if (identity === undefined || summary === undefined || summary.length > 1000) throw new SchemaError(PROVIDER, 'Rincos omitted required shipment details');
  const tables = form.find('table.type_list'), destination = form.find('.css_test table.type_list1');
  if (tables.length !== 2 || destination.length !== 1
    || tables.eq(0).find('thead th').toArray().map(node => clean($(node).text())).join('|') !== 'Date|Status|Location|Remark'
    || tables.eq(1).find('thead th').toArray().map(node => clean($(node).text())).join('|') !== 'Date|Status|Location') {
    throw new SchemaError(PROVIDER, 'Rincos changed its history panels');
  }
  const originRows = tables.eq(0).children('tbody').children('tr');
  const destinationRows = destination.children('tbody').children('tr');
  if (tables.eq(1).children('tbody').children('tr').length || originRows.length + destinationRows.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'Rincos returned unexpected or excessive history');
  }
  const notices = form.find('.Tracking_tit2');
  if (notices.length !== 1) throw new SchemaError(PROVIDER, 'Rincos changed its lookup notice');
  if (notices.text().length > 2000) throw new SchemaError(PROVIDER, 'Rincos returned an excessive lookup notice');
  const notice = clean(notices.text(), 2000);
  if (notice) {
    const absent = /^해당 번호의 정보가 없습니다\.\s*\[\s*(\d+)\s*\]$/.exec(notice);
    if (!absent || absent[1] !== number || identity || summary.trim() || originRows.length || destinationRows.length) {
      throw new IndeterminateError(PROVIDER, 'Rincos returned an inconclusive lookup notice');
    }
    // The notice says there is no information, not whether the number never existed.
    throw new NoHistoryError(PROVIDER, 'Rincos has no available history for this number', { reason: 'portal_not_found' });
  }
  if (!identity) throw new IndeterminateError(PROVIDER, 'Rincos returned no shipment identity');
  if (normalizeTrackingNumber(identity) !== number) throw new SchemaError(PROVIDER, 'Rincos returned another shipment');

  const origin: CarrierEvent[] = [], abroad: CarrierEvent[] = [];
  for (const [rows, width, target] of [[originRows, 4, origin], [destinationRows, 3, abroad]] as const) {
    for (const row of rows.toArray()) {
      const cells = $(row).children('td');
      if (cells.length !== width || cells.toArray().some(cell => $(cell).text().length > 2000)) throw new SchemaError(PROVIDER, 'Rincos returned a malformed scan');
      const description = clean(cells.eq(1).text(), 500);
      if (!description) throw new SchemaError(PROVIDER, 'Rincos returned an unnamed scan');
      const at = clock(clean(cells.eq(0).text(), 80));
      const location = locationText(cells.eq(2).text(), description);
      const staged = rincosStage(description);
      target.push({ ...at, description, ...(location ? { location } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
    }
  }
  // Preserve the carrier's order within each leg; different facility clocks cannot be sorted together.
  const seen = new Set<string>();
  const events = [...origin, ...abroad].reverse().filter(event => {
    const key = JSON.stringify([event.time ?? event.local_time, event.description, event.location]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const newest = events[0], summaryText = clean(summary, 500), mappedSummary = summaryText ? rincosStage(summaryText) : null;
  if (!newest && !mappedSummary) throw new NoHistoryError(PROVIDER, 'Rincos returned no usable shipment history');
  const incomplete = !newest || !!(mappedSummary && mappedSummary.stage !== newest.stage);
  const current = incomplete && mappedSummary ? mappedSummary : newest?.stage
    ? { stage: newest.stage as Stage, source: newest.stage_source } : null;
  const courier = fields.get('Local Courier') ?? '';
  const country = /\(Nation Code\s*:\s*([A-Z]{2})\)\s*$/.exec(courier)?.[1];
  const partner = country === 'JP' && /^Sagawa Express AIR\s*\(/i.test(courier) ? 'sagawa'
    : /^FedEx(?: MallTail)?\s*\(/i.test(courier) ? 'fedex' : null;
  const partnerNumber = normalizeTrackingNumber(fields.get('Local Tracking No.') ?? '');
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: incomplete && mappedSummary ? summaryText : newest?.description ?? summaryText,
    last_update: newest?.time ?? null, last_update_local: newest?.local_time ?? null, expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(partner && /^\d{12}$/.test(partnerNumber) ? { delivery_carrier: partner, delivery_tracking_number: partnerNumber } : {}),
    ...(!newest ? { summary_only: true } : {}),
    ...(events.length > MAX_EVENTS || (newest && incomplete) ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS) };
}
