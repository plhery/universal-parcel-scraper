import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForScan } from './status.js';

export const PROVIDER = 'AKIS Express';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter an AKIS tracking number of up to 20 characters');
  return number;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'AKIS tracking returned a browser check');
  }
  let reply: unknown;
  try { reply = JSON.parse(body); }
  catch { throw new SchemaError(PROVIDER, 'AKIS tracking returned invalid JSON'); }
  if (!isRecord(reply) || reply.success !== true || typeof reply.html !== 'string') {
    throw new SchemaError(PROVIDER, 'AKIS tracking returned no result fragment');
  }

  const $ = load(reply.html);
  const result = $('#package-results');
  const table = result.find('table#truck-package-table');
  const heading = result.children('h4');
  if (result.length !== 1 || table.length !== 1 || heading.length !== 1 || heading.text().trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'AKIS tracking did not identify the requested shipment');
  }
  const history = table.children('tbody');
  if (history.length !== 1) throw new SchemaError(PROVIDER, 'AKIS tracking history table changed');
  const rows = history.children('tr');
  if (rows.length === 1 && rows.first().children().length === 0) throw new NotFoundError(PROVIDER);
  const events: CarrierEvent[] = rows.filter((_, row) => $(row).children().length > 0).map((_, row) => {
    const cells = $(row);
    const description = clean(cells.children('[data-label=Status]').text(), 500);
    const location = clean(cells.children('[data-label=Station]').text(), 120);
    const date = zonedTime(cells.children('[data-label=Date]').text(), 'dd/MM/yyyy HH:mm', 'UTC');
    if (!date || !description) throw new SchemaError(PROVIDER, 'AKIS tracking returned an incomplete scan');
    const stage = stageForScan(description);
    return { local_time: date.iso.slice(0, 19), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).get();
  if (!events.length) throw new SchemaError(PROVIDER, 'AKIS tracking returned an unrecognized empty history');
  return trackingResult(events);
}

function trackingResult(events: CarrierEvent[]): CarrierResult {
  const newest = events[0]!;
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
