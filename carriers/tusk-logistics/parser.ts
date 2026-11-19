import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';

export const PROVIDER = 'Tusk Logistics';
const stages = new Map<string, Stage>([
  ['created', 'registered'],
  ['label created', 'registered'],
  ['received by carrier', 'accepted'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

export function parseTuskLogistics(html: string, number: string): CarrierResult {
  const $ = load(html);
  const detail = $('li').toArray().map(item => $(item).text().trim());
  const references = detail.filter(text => /^Tracking Number:\s*/i.test(text));
  if (!references.length && $('h1').toArray().some(item => $(item).text().trim() === 'Shipment not found!')) {
    throw new NotFoundError(PROVIDER);
  }
  if (references.length !== 1 || references[0]!.replace(/^Tracking Number:\s*/i, '').toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Guest page did not identify the requested shipment');
  }
  const rows = $('table.parcel_table').filter((_, table) =>
    $(table).find('thead th').toArray().map(cell => $(cell).text().trim()).join('|') === 'Event Time|Status|City|State|Details',
  ).find('tbody tr').toArray();
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Tusk Logistics returned too many rows');
  const events = rows.map(row => {
    const cells = $(row).children('td').toArray();
    const [clock, status, city, state, details] = cells.map(cell => clean($(cell).text(), 240));
    const wall = DateTime.fromFormat(clock ?? '', 'M/d/yyyy h:mm a', { locale: 'en-US', zone: 'UTC' });
    if (cells.length !== 5 || !status || !wall.isValid) throw new SchemaError(PROVIDER, 'Invalid dated Tusk scan');
    const stage = stages.get(status.toLowerCase());
    const location = [city, state].filter(Boolean).join(', ');
    return {
      local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      // The partner's sentence, unless it names who signed or a code: then the status alone.
      description: details && !hasPrivateDeliveryDetails(details) ? details : status,
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });
  const latest = events[0]!;
  const summary = detail.find(text => /^Label Status:\s*/i.test(text))?.replace(/^Label Status:\s*/i, '');
  const stage = (summary ? stages.get(summary.toLowerCase()) : undefined) ?? latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: summary ?? latest.description,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}
