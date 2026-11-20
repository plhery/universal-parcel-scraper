import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'mol-ace';

export function parseTracking(body: string, bill: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'MOL ACE requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'MOL ACE did not return tracking JSON');
  }
  if (isRecord(reply) && reply.isValid === false && reply.ReturnType === 'NoInfo' && reply.ReturnString === bill) {
    throw new NotFoundError(provider);
  }
  if (!isRecord(reply) || reply.isValid !== true || typeof reply.data !== 'string') {
    throw new SchemaError(provider, 'MOL ACE omitted the tracking grid');
  }
  const $ = load(reply.data);
  const table = $('#myTable');
  const names = table.find('thead th').map((_, element) => clean($(element).text())).get();
  const billColumn = names.indexOf('BL#');
  const movements = [
    { clockColumn: names.indexOf('ATD / ETD'), portColumn: names.indexOf('POL'), description: 'Actual Departure' },
    { clockColumn: names.indexOf('ATA / ETA'), portColumn: names.indexOf('POD'), description: 'Actual Arrival' },
  ];
  if (table.length !== 1 || billColumn === -1 || movements.some(({ clockColumn, portColumn }) => clockColumn < 0 || portColumn < 0)) {
    throw new SchemaError(provider, 'MOL ACE changed the tracking grid columns');
  }
  const rows = table.find('tbody tr').toArray().map(row => $(row).children('td')).filter(cells => cells.length === names.length);
  if (!rows.length) throw new IndeterminateError(provider, 'MOL ACE did not confirm the bill');
  const events = new Map<string, CarrierEvent>();
  for (const cells of rows) {
    if (clean(cells.eq(billColumn).text()) !== bill) throw new IndeterminateError(provider, 'MOL ACE returned a different bill');
    for (const { clockColumn, portColumn, description } of movements) {
      const cell = cells.eq(clockColumn);
      if (!cell.hasClass('text-success')) continue;
      const date = DateTime.fromFormat(clean(cell.text()), 'd-LLL-yyyy h:mm a', { zone: 'utc', locale: 'en-US' });
      if (!date.isValid) continue;
      const location = clean(cells.eq(portColumn).text());
      const local = date.toFormat("yyyy-MM-dd'T'HH:mm");
      events.set(JSON.stringify([local, description, location]), {
        description, local_time: local, stage: scanStages.get(description), stage_source: 'carrier_map',
        ...(location && !hasPrivateDeliveryDetails(location) && { location }),
      });
    }
  }
  const history = [...events.values()].sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const latest = history[0];
  const stage = latest?.description ? scanStages.get(latest.description) : undefined;
  if (!stage || !latest) throw new IndeterminateError(provider, 'MOL ACE lists the bill without actual port movements', { reason: 'listed' });
  return {
    status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events: history,
  };
}
