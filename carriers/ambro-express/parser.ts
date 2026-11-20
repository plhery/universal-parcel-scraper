import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForScan } from './status.js';

export const PROVIDER = 'Ambro Express';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a 13-character Ambro Express shipment number');
  return number;
}

export function parseTracking(body: string): CarrierResult {
  if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Ambro Express returned a browser check');
  }
  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(PROVIDER, 'Ambro Express returned invalid tracking JSON'); }
  if (!isRecord(reply) || reply.state !== 1 || !isRecord(reply.content)
    || reply.content.type !== 'success' || typeof reply.content.content !== 'string') {
    throw new SchemaError(PROVIDER, 'Ambro Express returned no tracking fragment');
  }

  const $ = load(reply.content.content);
  if ($('.alert-danger .message').text().trim() === 'Nie znaleziono' && !$('#results-table').length) {
    throw new NotFoundError(PROVIDER);
  }
  const table = $('#results-table');
  const rows = table.find('tbody > tr').toArray();
  const headings = $(rows.shift()).children('th').map((_, cell) => $(cell).text().trim()).get();
  if (table.length !== 1 || headings.join('|') !== 'Data|Czas|Status' || !rows.length) {
    throw new SchemaError(PROVIDER, 'Ambro Express returned an unrecognized history table');
  }
  // The fragment is returned by a form submission of one shipment and has no number of its own.
  const events: CarrierEvent[] = rows.reverse().map(row => {
    const cells = $(row).children('td');
    const description = clean(cells.eq(2).text(), 500);
    const date = zonedTime(cells.eq(0).text().trim() + ' ' + cells.eq(1).text().trim(), 'yyyy-MM-dd HH:mm:ss', 'UTC');
    if (cells.length !== 3 || !date || !description) throw new SchemaError(PROVIDER, 'Ambro Express returned an incomplete scan');
    const stage = stageForScan(description);
    return { local_time: date.iso.slice(0, 19), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_update: null,
    last_update_local: newest.local_time,
    last_status_text: newest.description,
    expected_delivery: null,
    events,
  };
}
