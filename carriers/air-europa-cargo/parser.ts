import { load } from 'cheerio';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Air Europa Cargo';

const AIRPORT = /^[A-Z]{3}$/;
const STATION_WORDING = /^(?:Departed|Received|Freight on Hands) ([A-Z]{3})(?: GHA)?$/i;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LIMIT = 100;

export function normalizeAirEuropaNumber(input: string): string {
  const number = input.replace(/\s+/g, '');
  const match = /^996[-/]?(\d{8})$/.exec(number);
  if (!match) throw new InvalidInputError(PROVIDER, 'Enter the Air Europa master air waybill beginning with 996');
  return '996-' + match[1];
}

export function parseAirEuropaCargo(html: string, number: string): CarrierResult {
  const $ = load(html);
  const tables = $('table');
  const summary = tables.filter((_, table) => clean($(table).find('tr').first().text(), 60) === 'SHIPMENT').first();
  const summaryValue = (label: string): string => clean(summary.find('tr').filter((_, row) =>
    clean($(row).children('td').first().text(), 24) === label).first().children('td').eq(1).text(), 40);
  if (summaryValue('AWB:') !== number) {
    const miss = tables.find('td').toArray().some(cell =>
      clean($(cell).text(), 80) === 'Sorry. ' + number + ' Not Found');
    if (!summary.length && miss) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Air Europa did not identify the requested air waybill');
  }

  const operations = tables.filter((_, table) =>
    clean($(table).find('tr').first().text(), 60) === 'OPERATIONAL INFORMATION').first();
  if (!operations.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const headers = operations.find('tr').eq(1).children('td, th').map((_, cell) => clean($(cell).text(), 30)).get();
  if (headers.join('|') !== 'ORG|DST|FLIGHT/DATE|PCS/KGS|STATUS|DATE|TIME') {
    throw new SchemaError(PROVIDER, 'Air Europa changed the history columns');
  }

  const shipmentOrigin = summaryValue('ORG:');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of operations.find('tr').slice(2).toArray()) {
    const cells = $(row).children('td');
    if (!clean(cells.text(), 500)) continue;
    // The FLIGHT/DATE heading spans the flight number and flight date cells.
    if (cells.length !== 8) throw new SchemaError(PROVIDER, 'Air Europa returned an incomplete history row');
    const values = cells.map((_, cell) => clean($(cell).text(), 180)).get();
    const [origin = '', destination = '', , , , description, date, clock] = values;
    const match = DATE.exec(date ?? '');
    const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
    if (!description || !day || !clock || !CLOCK.test(clock)) {
      throw new SchemaError(PROVIDER, 'Air Europa returned an undated or incomplete scan');
    }

    const local_time = day + 'T' + clock + ':00';
    const code = /^[A-Z]{3}$/.test(description) ? description : null;
    const wording = normalizeStatusWording(description);
    const mapped = statusMap.stage(code, wording);
    const stage = mapped === 'accepted' && AIRPORT.test(origin) && origin !== shipmentOrigin ? 'in_transit' : mapped;
    const station = STATION_WORDING.exec(description)?.[1]?.toUpperCase();
    const location = station ?? ((wording === 'delivery' || code === 'ARR') && AIRPORT.test(destination) ? destination : undefined);

    const key = values.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      local_time, description,
      ...(code ? { provider_code: code } : {}),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
  }
  // Air Europa gives no timezone. Order by the printed clocks, keeping its order at ties.
  events.sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events: events.slice(0, LIMIT),
    ...(events.length > LIMIT ? { history_truncated: true } : {}),
  };
}
