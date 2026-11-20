import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { movementStages, originMovements } from './status.js';

export const provider = 'pasha-hawaii';

const equipmentColumns = [
  'Move Date', 'Time', 'Moved From', 'Moved To', 'Status', 'Booking No', 'B/L No', 'Vessel/Voyage',
];
const billColumns = [
  'ItemNo.', 'Container No.', 'Size/Type', 'PieceCount', 'MetricTons', 'CubicMeters', 'Date', 'Status', 'Location',
];

function localDate(day: string, clock = ''): string {
  const date = day.replace(/\s*,\s*/g, ', ');
  const input = clock ? date + ' ' + clock : date;
  const format = clock ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy';
  const parsed = DateTime.fromFormat(input, format, { locale: 'en-US', zone: 'utc' });
  if (!parsed.isValid) throw new SchemaError(provider, 'Pasha Hawaii returned an invalid movement date');
  return clock ? parsed.toFormat("yyyy-MM-dd'T'HH:mm") : parsed.toISODate();
}

type Movement = CarrierEvent & { stage?: Stage };

function event(day: string, clock: string, description: string, place: string): Movement {
  if (!description || hasPrivateDeliveryDetails(description)) {
    throw new SchemaError(provider, 'Pasha Hawaii omitted a movement status');
  }
  const stage = movementStages.get(description);
  const location = hasPrivateDeliveryDetails(place) ? '' : place;
  return {
    local_time: localDate(day, clock), description,
    ...(location && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseTracking(body: string, number: string, type: 'EQ' | 'BL'): CarrierResult {
  const $ = load(body);
  if (clean($('title').text()) !== 'Pasha Hawaii Container Track and Trace') {
    throw new SchemaError(provider, 'Pasha Hawaii did not return its cargo tracker');
  }

  const tables = $('table').toArray().filter(node => !$(node).find('table').length);
  const rows = tables.map(node => $(node).find('tr').toArray().map(row =>
    $(row).children('th,td').toArray().map(cell => clean($(cell).text())),
  ));
  const identityLabel = type === 'EQ' ? 'Container Number' : 'B/L Number';
  const identity = rows.find(table => table[0]?.[0] === identityLabel)?.[1]?.[0];
  if (!identity) throw new IndeterminateError(provider, 'Pasha Hawaii did not identify the requested freight');
  if (identity !== number) throw new IndeterminateError(provider, 'Pasha Hawaii answered for a different reference');

  const columns = type === 'EQ' ? equipmentColumns : billColumns;
  const movements = rows.find(table => table[0]?.join('|') === columns.join('|'))?.slice(1);
  if (!movements) throw new SchemaError(provider, 'Pasha Hawaii omitted its movement table');

  const distinct = new Map<string, Movement>();
  for (const row of movements) {
    if (row.length !== columns.length) throw new SchemaError(provider, 'Pasha Hawaii returned an invalid movement row');
    let scan: Movement;
    if (type === 'EQ') {
      const [date, time, from, to, status] = row;
      scan = event(date!, time!, status!, originMovements.has(status!) ? from! : to!);
    } else {
      const date = row[6]!;
      const status = row[7]!;
      if (!status && !date) continue;
      scan = event(date, '', status, row[8]!);
    }
    distinct.set(JSON.stringify(scan), scan);
  }

  const events = [...distinct.values()].sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Pasha Hawaii listed the reference without dated movements', { reason: 'listed' });
  const stage = (type === 'EQ' || events.every(scan => scan.stage === latest.stage)) ? latest.stage : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(type === 'EQ' || events.every(scan => scan.description === latest.description)
      ? { last_status_text: latest.description } : {}),
    last_update_local: latest.local_time, events,
  };
}
