import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { scanStages } from './status.js';

export const PROVIDER = 'Interlogistica';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,60}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter an Interlogistica waybill');
  return number;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Interlogistica returned a browser check');
  }
  const $ = load(body);
  const result = $('#cx_tracking_result');
  const formNumber = $('#formTracking input[name=edTrackingNumber]').val();
  if (result.length !== 1 || typeof formNumber !== 'string' || formNumber.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Interlogistica did not answer the requested waybill form');
  }
  if (!result.children().length && !result.text().trim()) throw new NotFoundError(PROVIDER);
  const table = result.children('table');
  const id = table.find('tr.trackInfo b');
  if (table.length !== 1 || id.length !== 1 || id.text().trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Interlogistica did not identify the requested shipment');
  }

  const events: CarrierEvent[] = table.find('tr.trackRow').toArray().reverse().map(row => {
    const cells = $(row).children('td');
    const date = zonedTime(cells.eq(0).text(), 'yyyy-MM-dd HH:mm:ss', 'UTC');
    const description = clean(cells.eq(1).text(), 500);
    const location = clean(cells.eq(2).text(), 120);
    if (cells.length !== 3 || !date || !description) throw new SchemaError(PROVIDER, 'Interlogistica returned an incomplete scan');
    const stage = scanStages.stage(null, description);
    return { local_time: date.iso.slice(0, 19), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const leading = leadingScan(events, scanStages);
  const stage = leading?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: (leading ?? newest).description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
