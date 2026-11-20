import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'gardewine';

const readableText = (value: string) => value.trim().replace(/\s+/g, ' ');

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Gardewine requires verification');
  }
  const $ = load(body);
  const header = $('th').filter((_, node) => readableText($(node).text()) === 'Shipment Number:');
  const reference = header.next('td');
  if (header.length !== 1 || reference.length !== 1) throw new SchemaError(provider, 'Gardewine omitted the shipment number');
  if (readableText(reference.text()) !== number) {
    throw new IndeterminateError(provider, 'Gardewine returned a different shipment number');
  }

  const history = $('thead tr').filter((_, node) => {
    const columns = $(node).children('th').map((_, column) => readableText($(column).text())).get();
    return columns.join('|') === 'Shipment Status|Location|Date|Time';
  }).closest('table');
  if (history.length !== 1) throw new SchemaError(provider, 'Gardewine omitted the movement table');

  const events = history.find('tbody tr').toArray().map(row => {
    const cells = $(row).children('td').map((_, cell) => readableText($(cell).text())).get();
    const [description, location, day, time] = cells;
    const date = DateTime.fromFormat(`${day} ${time}`, 'MM/dd/yyyy hh:mm a', { zone: 'utc', locale: 'en' });
    if (cells.length !== 4 || !description || !date.isValid) throw new SchemaError(provider, 'Gardewine returned an invalid movement');
    const stage = scanStage(description);
    const place = location && !/^(?:In Transit|Customer Care Center)$/i.test(location) ? location : undefined;
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"), description,
      ...(place && { location: place }), ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Gardewine listed the shipment without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
