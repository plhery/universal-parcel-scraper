import { load } from 'cheerio';
import { isVXpressReference } from '../../core/detection/vXpress.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { vXpressStage } from './status.js';

export const PROVIDER = 'V-Xpress';
export const TRACKING_URL = 'https://vxpress.in/sx_trackapi.php';
export function normalizeVXpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'V-Xpress needs a docket number');
  if (!isVXpressReference(number)) throw new NoHistoryError(PROVIDER, 'The guest route supports seven- or ten-digit dockets', { reason: 'unsupported_reference' });
  return number;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function clock(value: string): string {
  const match = /^(0?[1-9]|[12]\d|3[01])-([A-Za-z]{3})-(\d{4}) (0?[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/i.exec(value);
  const day = match ? calendarDay(Number(match[3]), MONTHS.indexOf(match[2]!.toLowerCase()) + 1, Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'V-Xpress returned an invalid scan clock');
  const hour = Number(match[4]) % 12 + (match[6]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${match[5]}`;
}
function description(raw: string): string | null {
  // Account edits, references and proof administration do not record movement.
  if (!raw || /^LR\b.*(?:is force added to Trip|emailed to:)/i.test(raw) || /^Trip#/i.test(raw)
    || /^Seal#.*\(\s*only data dispatch\s*\)$/i.test(raw) || /^(?:E?POD copy received|Consignee\b.*\bis modified)$/i.test(raw)) return null;
  if (/^Unloaded from manifest\s+\S+\s+at\s+\S/i.test(raw)) return 'Unloaded at facility';
  if (/^Unloaded at delivery branch\s+\S/i.test(raw)) return 'Arrived at delivery branch';
  if (/^Loaded for manifest\s+\S+$/i.test(raw)) return 'Loaded for transport';
  if (/^Seal#.*\(\s*Mobile dispatch\s*\)$/i.test(raw)) return 'Dispatch recorded';
  if (/^Delivered(?: to\s+\S.*)?$/i.test(raw)) return 'Delivered';
  for (const wording of ['All Package Label Generated', 'Package Labels Printed', 'Out for delivery']) {
    if (raw.toLowerCase() === wording.toLowerCase()) return wording;
  }
  // Even useful scans may embed contact details in this field.
  return 'Tracking update';
}

export function parseVXpress(html: string, raw: string): CarrierResult {
  const number = normalizeVXpressNumber(raw), $ = load(html); $('script,style,template').remove();
  const summaries = $('table.information-about-docket-tab'), headings = $('th').filter((_, el) => /^Movement Of Docket No\./i.test(clean($(el).text())));
  const text = clean($('body').text(), 1024 * 1024);
  if (text === 'Docket Not Found......' && !summaries.length && !headings.length) throw new NotFoundError(PROVIDER);
  if (/Docket Not Found/i.test(text) || summaries.length !== 1 || headings.length !== 1) throw new SchemaError(PROVIDER, 'V-Xpress returned no unique shipment');
  const value = (element: ReturnType<typeof $>, label: string): string => {
    if (element.length !== 1 || element.children('span').length !== 1 || clean(element.children('span').text()) !== label) throw new SchemaError(PROVIDER, 'V-Xpress changed a shipment field');
    return clean(element.clone().children('span').remove().end().text(), 1001);
  };
  if (value(summaries.find('[data-key="number"]'), 'Docket No.') !== number || clean(headings.text()) !== `Movement Of Docket No. ${number}`) throw new SchemaError(PROVIDER, 'V-Xpress returned another whole docket');
  const current = value(summaries.find('[data-key="readable_status"]'), 'Current Status');
  if (!current || current.length > 100 || /[<>@\d]|https?:|\b(?:consignee|recipient|phone|address)\b/i.test(current)) throw new SchemaError(PROVIDER, 'V-Xpress returned an invalid current status');
  const movement = headings.closest('table.movement-docket-tab'), tables = movement.find('.movement > table');
  if (movement.length !== 1 || tables.length !== 1) throw new SchemaError(PROVIDER, 'V-Xpress changed its movement table');
  const rows = tables.children('tbody').children('tr');
  if (rows.length > 1000 || rows.length % 2 !== 0) throw new SchemaError(PROVIDER, 'V-Xpress changed its scan rows or exceeded their limit');
  const events: CarrierEvent[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const fields = rows.eq(index).children('td'), location = rows.eq(index + 1).children('td');
    if (fields.length !== 4 || clean(fields.eq(0).text()) !== 'Date' || clean(fields.eq(2).text()) !== 'Details'
      || location.length !== 2 || clean(location.eq(0).text()) !== 'Location') throw new SchemaError(PROVIDER, 'V-Xpress changed a scan row');
    const local_time = clock(clean(fields.eq(1).text(), 80)), detail = clean(fields.eq(3).text(), 2001);
    if (detail.length > 2000 || [...detail.matchAll(/\bLR\s+(\d+)\b/gi)].some(match => match[1] !== number)) throw new SchemaError(PROVIDER, 'V-Xpress returned an invalid or unrelated scan');
    const wording = description(detail);
    if (!wording) continue;
    const stage = vXpressStage(null, wording);
    // Location includes recipient names on delivery rows; omit it with the raw details.
    events.push({ local_time, description: wording, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'V-Xpress knows the docket but returned no scan history', { reason: 'parcel_found' });
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const stage = vXpressStage(null, current), latestStage = events.find(event => event.stage)?.stage;
  if ((stage === 'delivered') !== (latestStage === 'delivered')) throw new SchemaError(PROVIDER, 'V-Xpress summary and delivery scans disagree');
  const seen = new Set<string>(), distinct = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  // Summary and timeline have different unlabelled clocks; do not graft its delivery/ETA clock onto a scan.
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current, last_update: null, last_update_local: distinct[0]!.local_time, expected_delivery: null,
    ...(distinct.length > 100 ? { history_truncated: true } : {}), events: distinct.slice(0, 100) };
}
