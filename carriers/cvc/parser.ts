import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { stageForScan } from './status.js';

export const PROVIDER = 'CVC';

export function normalizeNumber(raw: string): string {
  const number = raw.trim();
  if (!/^\d{1,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a CVC waybill of up to 20 digits');
  return number;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'CVC returned a browser check');
  }

  const $ = load(body);
  const root = $('.loginBoxInner');
  const history = root.find('#tblRows');
  const absent = root.find('form:has(input[name=wb]) .h4').text().trim() === 'Пратката не е открита!';
  if (root.length === 1 && !history.length && absent) throw new NotFoundError(PROVIDER);
  const id = root.find('.h4 > .mark.yellow');
  if (root.length !== 1 || history.length !== 1 || id.length !== 1 || id.text().trim() !== number) {
    throw new SchemaError(PROVIDER, 'CVC tracking did not identify the requested waybill');
  }

  const events: CarrierEvent[] = history.children('.tblRow').toArray().reverse().map(row => {
    const cells = $(row).children('.tblItem');
    const day = cells.eq(0).clone();
    const clock = day.children('.note').remove().text().trim();
    const date = zonedTime(day.text().trim() + ' ' + clock, 'dd.MM.yyyy HH:mm:ss', 'UTC');
    const description = clean(cells.eq(1).text(), 500);
    if (cells.length !== 2 || !date || !description) throw new SchemaError(PROVIDER, 'CVC returned an incomplete scan');
    const stage = stageForScan(description);
    return { local_time: date.iso.slice(0, 19), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
