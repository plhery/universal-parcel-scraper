import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import { statusMap, thabitStage } from './status.js';

export const PROVIDER = 'Thabit Logistics';
export const THABIT_ORIGIN = 'https://thabit-logistics.com';
export const THABIT_MAX_BYTES = 600_000;
const ISO_CLOCK = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeThabitNumber(raw: string): string {
  const number = raw.length <= 100 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Thabit tracking takes an air waybill number');
  return number;
}
export function thabitTrackingUrl(raw: string): string {
  return THABIT_ORIGIN + '/track-shipment/' + normalizeThabitNumber(raw);
}

/** Server clocks remain in data-utc-time after the page localizes their visible text. */
function scanClock(text: string, original?: string): string {
  const raw = text.trim().replace(/\s*\(loading\.\.\.\)$/, '');
  const clock = original?.trim() ?? raw;
  if (!ISO_CLOCK.test(clock) || !DateTime.fromISO(clock, { setZone: true }).isValid) {
    throw new SchemaError(PROVIDER, 'Thabit returned an unsupported scan clock');
  }
  if (original !== undefined && ISO_CLOCK.test(raw) && raw !== clock) {
    throw new IndeterminateError(PROVIDER, 'Thabit returned conflicting scan clocks');
  }
  return clock;
}

export function parseThabit(html: string, raw: string): CarrierResult {
  const number = normalizeThabitNumber(raw), url = thabitTrackingUrl(number);
  if (/_cf_chl_opt|_Incapsula_Resource|ModSecurity|mod_security|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Thabit requires browser verification');
  }
  const $ = load(html); $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  const canonical = $('link[rel="canonical"]');
  const form = $('form').filter((_index, el) => $(el).attr('action') === THABIT_ORIGIN + '/track-shipment');
  const input = form.find('input#airway_bill_no[name="airway_bill_no"]');
  if (canonical.length !== 1 || form.length !== 1 || form.attr('method')?.toUpperCase() !== 'POST' || input.length !== 1) {
    throw new SchemaError(PROVIDER, 'Thabit changed its tracking page');
  }
  if (canonical.attr('href') !== url || input.attr('value')?.trim() !== number) {
    throw new IndeterminateError(PROVIDER, 'Thabit did not confirm the whole requested waybill');
  }
  const table = $('table.table');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Thabit returned no unique tracking table');
  const heads = table.find('th').toArray().map(el => clean($(el).text()));
  if (heads.length === 1 && heads[0] === 'Record Not Found') {
    if (table.find('td').length) throw new IndeterminateError(PROVIDER, 'Thabit returned conflicting tracking outcomes');
    throw new NotFoundError(PROVIDER);
  }
  if (heads.join('|') !== 'وضع|تاريخ|Station Name') throw new SchemaError(PROVIDER, 'Thabit changed its scan columns');
  const rows = table.find('tr').filter((_index, el) => $(el).find('td').length > 0);
  if (!rows.length || rows.length > 500) throw new SchemaError(PROVIDER, 'Thabit returned no supported scan history');
  const events: CarrierEvent[] = rows.toArray().map(el => {
    const cells = $(el).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Thabit changed a scan row');
    const description = clean(cells.eq(0).text(), 300), location = clean(cells.eq(2).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Thabit returned an empty scan wording');
    const time = scanClock(cells.eq(1).text(), cells.eq(1).attr('data-utc-time'));
    const staged = thabitStage(description);
    if (!staged && !statusGapNote(statusMap, null, normalizeStatusWording(description))) {
      throw new SchemaError(PROVIDER, 'Thabit returned an unsupported milestone');
    }
    // Administrative counters or assignments assert no physical milestone.
    return { time, description, ...(location ? { location } : {}), stage: staged?.stage ?? 'pending', stage_source: staged?.source ?? 'none' };
  }).sort((a, b) => DateTime.fromISO(b.time, { setZone: true }).toMillis() - DateTime.fromISO(a.time, { setZone: true }).toMillis());
  const newest = events[0]!, current = events.find(event => event.stage !== 'pending' && event.stage_source !== 'none');
  const stage = (current?.stage ?? 'pending') as Stage;
  return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: current?.stage_source ?? 'none',
    last_status_text: newest.description, last_update: newest.time, expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
